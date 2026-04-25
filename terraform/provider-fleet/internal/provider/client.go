// Package provider implements the `fleet` Terraform provider.
//
// client.go is a tiny JSON-over-HTTP wrapper around the Fleet Manager admin
// API. We intentionally keep it dependency-free (stdlib only) — the
// Plugin Framework and the OpenAPI-ish shape of the manager's admin
// endpoints are both stable and small.
package provider

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client talks to the Fleet Manager admin REST surface.
type Client struct {
	endpoint   string // e.g. "http://localhost:9090" (no trailing slash)
	adminToken string
	http       *http.Client
	userAgent  string
}

func NewClient(endpoint, adminToken, userAgent string) *Client {
	endpoint = strings.TrimRight(endpoint, "/")
	return &Client{
		endpoint:   endpoint,
		adminToken: adminToken,
		userAgent:  userAgent,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// APIError is returned when the manager responds with a non-2xx status. It is
// surfaced in Terraform diagnostics so operators can see exactly what went
// wrong.
type APIError struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("fleet-manager API error: %s %s -> %d: %s", e.Method, e.Path, e.Status, e.Body)
}

// IsNotFound reports whether the error was a 404 from the manager. Useful for
// the resource Read path, which must silently drop from state when the
// backing object has been deleted out-of-band.
func IsNotFound(err error) bool {
	var ae *APIError
	if err == nil {
		return false
	}
	if asErr, ok := err.(*APIError); ok {
		return asErr.Status == http.StatusNotFound
	}
	_ = ae
	return false
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reqBody io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal %s %s: %w", method, path, err)
		}
		reqBody = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.endpoint+path, reqBody)
	if err != nil {
		return fmt.Errorf("build request %s %s: %w", method, path, err)
	}
	req.Header.Set("Accept", "application/json")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.adminToken != "" {
		req.Header.Set("Authorization", "Bearer "+c.adminToken)
	}
	if c.userAgent != "" {
		req.Header.Set("User-Agent", c.userAgent)
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("http %s %s: %w", method, path, err)
	}
	defer resp.Body.Close()

	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{Method: method, Path: path, Status: resp.StatusCode, Body: strings.TrimSpace(string(raw))}
	}
	// 204 / empty body is fine; only decode when caller asked for it.
	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode response %s %s: %w (body=%s)", method, path, err, string(raw))
	}
	return nil
}

// ---------- API DTOs ---------------------------------------------------------
//
// Kept local (not shared with the Node.js server) because the provider must be
// usable as an external Go module without pulling in the monorepo.

type Pipeline struct {
	ID             string            `json:"id"`
	Name           string            `json:"name"`
	Selector       map[string]string `json:"selector"`
	Enabled        bool              `json:"enabled"`
	CurrentVersion int64             `json:"current_version"`
	CurrentContent string            `json:"current_content"`
	CurrentHash    string            `json:"current_hash"`
	CreatedAt      string            `json:"created_at"`
	UpdatedAt      string            `json:"updated_at"`
}

type PipelineVersion struct {
	ID        string            `json:"id"`
	Version   int64             `json:"version"`
	Hash      string            `json:"hash"`
	Selector  map[string]string `json:"selector"`
	CreatedAt string            `json:"created_at"`
}

type PipelineDetail struct {
	Pipeline Pipeline          `json:"pipeline"`
	Versions []PipelineVersion `json:"versions"`
}

type Collector struct {
	ID              string            `json:"id"`
	Name            *string           `json:"name"`
	LocalAttributes map[string]string `json:"local_attributes"`
	LastSeen        *string           `json:"last_seen"`
	LastStatus      *string           `json:"last_status"`
	LastError       *string           `json:"last_error"`
	LastHashServed  *string           `json:"last_hash_served"`
	CreatedAt       string            `json:"created_at"`
	UpdatedAt       string            `json:"updated_at"`
}

type CreatePipelineInput struct {
	Name     string            `json:"name"`
	Selector map[string]string `json:"selector"`
	Enabled  bool              `json:"enabled"`
	Content  string            `json:"content"`
}

type UpdatePipelineInput struct {
	Selector *map[string]string `json:"selector,omitempty"`
	Enabled  *bool              `json:"enabled,omitempty"`
	Content  *string            `json:"content,omitempty"`
}

// ---------- API methods ------------------------------------------------------

func (c *Client) CreatePipeline(ctx context.Context, in CreatePipelineInput) (*Pipeline, error) {
	var out Pipeline
	if err := c.do(ctx, http.MethodPost, "/pipelines", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetPipeline(ctx context.Context, id string) (*PipelineDetail, error) {
	var out PipelineDetail
	if err := c.do(ctx, http.MethodGet, "/pipelines/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ListPipelines(ctx context.Context) ([]Pipeline, error) {
	var out struct {
		Pipelines []Pipeline `json:"pipelines"`
	}
	if err := c.do(ctx, http.MethodGet, "/pipelines", nil, &out); err != nil {
		return nil, err
	}
	return out.Pipelines, nil
}

func (c *Client) UpdatePipeline(ctx context.Context, id string, in UpdatePipelineInput) (*Pipeline, error) {
	var out Pipeline
	if err := c.do(ctx, http.MethodPatch, "/pipelines/"+id, in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeletePipeline(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/pipelines/"+id, nil, nil)
}

func (c *Client) ListCollectors(ctx context.Context) ([]Collector, error) {
	var out struct {
		Collectors []Collector `json:"collectors"`
	}
	if err := c.do(ctx, http.MethodGet, "/remotecfg/collectors", nil, &out); err != nil {
		return nil, err
	}
	return out.Collectors, nil
}

// ---------------------------------------------------------------------------
// Identity / RBAC DTOs
// ---------------------------------------------------------------------------
//
// These mirror the manager's `routes/users.ts` / `routes/tokens.ts` shapes.
// Local copies (no shared schema with the Node side) so the provider stays a
// standalone Go module.

// RoleRef is the trimmed `{id, name}` shape returned inside Users and ApiTokens.
type RoleRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type Role struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	Description *string  `json:"description"`
	Builtin     bool     `json:"builtin"`
	Permissions []string `json:"permissions"`
}

type User struct {
	ID        string    `json:"id"`
	Email     string    `json:"email"`
	Name      *string   `json:"name"`
	Disabled  bool      `json:"disabled"`
	CreatedAt string    `json:"created_at"`
	UpdatedAt string    `json:"updated_at"`
	Roles     []RoleRef `json:"roles"`
}

type CreateUserInput struct {
	Email    string   `json:"email"`
	Name     *string  `json:"name,omitempty"`
	Password string   `json:"password"`
	RoleIDs  []string `json:"role_ids"`
	Disabled bool     `json:"disabled"`
}

type UpdateUserInput struct {
	Name     *string   `json:"name,omitempty"`
	Disabled *bool     `json:"disabled,omitempty"`
	RoleIDs  *[]string `json:"role_ids,omitempty"`
}

// ApiTokenSummary is the no-secrets shape returned by GET /tokens and
// GET /tokens/:id. The plaintext `token` is only ever returned once, by
// CreateApiToken, in CreateApiTokenResponse.
type ApiTokenSummary struct {
	ID          string    `json:"id"`
	UserID      string    `json:"user_id"`
	Name        string    `json:"name"`
	TokenPrefix string    `json:"token_prefix"`
	ExpiresAt   *string   `json:"expires_at"`
	RevokedAt   *string   `json:"revoked_at"`
	LastUsedAt  *string   `json:"last_used_at"`
	CreatedAt   string    `json:"created_at"`
	Roles       []RoleRef `json:"roles"`
}

type CreateApiTokenInput struct {
	Name      string   `json:"name"`
	UserID    *string  `json:"user_id,omitempty"`
	RoleIDs   []string `json:"role_ids"`
	ExpiresAt *string  `json:"expires_at,omitempty"`
}

// CreateApiTokenResponse mirrors the on-the-wire shape of `POST /tokens`:
//
//	{ "token": "fmt_…", "api_token": { …ApiTokenSummary… } }
//
// The summary is intentionally NOT embedded — the manager nests it under
// `api_token` to make plaintext-vs-metadata visually obvious in audit logs
// and HTTP traces. Earlier revisions of this DTO embedded the summary at
// the top level and silently produced empty IDs/names/role_ids in state
// after every Create — see Terraform's
// "Provider produced inconsistent result after apply" diagnostic.
type CreateApiTokenResponse struct {
	// Plaintext bearer. The manager will never return this again — the
	// provider must persist it to state immediately, with sensitive: true.
	Token    string          `json:"token"`
	ApiToken ApiTokenSummary `json:"api_token"`
}

// ---------------------------------------------------------------------------
// Identity / RBAC methods
// ---------------------------------------------------------------------------

func (c *Client) ListRoles(ctx context.Context) ([]Role, error) {
	var out struct {
		Roles []Role `json:"roles"`
	}
	if err := c.do(ctx, http.MethodGet, "/roles", nil, &out); err != nil {
		return nil, err
	}
	return out.Roles, nil
}

// FindRoleByName is a convenience for the agent-role lookup pattern. Returns
// nil with a nil error when the role doesn't exist (so callers can decide
// whether to fail loudly or silently).
func (c *Client) FindRoleByName(ctx context.Context, name string) (*Role, error) {
	roles, err := c.ListRoles(ctx)
	if err != nil {
		return nil, err
	}
	for i := range roles {
		if roles[i].Name == name {
			return &roles[i], nil
		}
	}
	return nil, nil
}

func (c *Client) ListUsers(ctx context.Context) ([]User, error) {
	var out struct {
		Users []User `json:"users"`
	}
	if err := c.do(ctx, http.MethodGet, "/users", nil, &out); err != nil {
		return nil, err
	}
	return out.Users, nil
}

func (c *Client) CreateUser(ctx context.Context, in CreateUserInput) (*User, error) {
	var out User
	if err := c.do(ctx, http.MethodPost, "/users", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetUser(ctx context.Context, id string) (*User, error) {
	var out User
	if err := c.do(ctx, http.MethodGet, "/users/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateUser(ctx context.Context, id string, in UpdateUserInput) (*User, error) {
	var out User
	if err := c.do(ctx, http.MethodPatch, "/users/"+id, in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) DeleteUser(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/users/"+id, nil, nil)
}

func (c *Client) CreateApiToken(ctx context.Context, in CreateApiTokenInput) (*CreateApiTokenResponse, error) {
	var out CreateApiTokenResponse
	if err := c.do(ctx, http.MethodPost, "/tokens", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetApiToken(ctx context.Context, id string) (*ApiTokenSummary, error) {
	var out ApiTokenSummary
	if err := c.do(ctx, http.MethodGet, "/tokens/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) RevokeApiToken(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/tokens/"+id, nil, nil)
}
