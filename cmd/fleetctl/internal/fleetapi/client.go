// Package fleetapi is a stdlib-only JSON-over-HTTP client for the Fleet
// Manager admin API.
//
// It's a deliberate near-duplicate of `terraform/provider-fleet/internal/
// provider/client.go`. Consolidating the two behind a shared Go module
// would force the Terraform provider's `go.mod` to pick up
// fleetctl-specific transitives (cobra et al.) — not worth the coupling.
// The DTOs are ~30 lines each; diverging is fine as long as the
// JSON tags stay in sync with the server.
package fleetapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	endpoint   string
	adminToken string
	http       *http.Client
	userAgent  string
}

type Options struct {
	Endpoint   string
	AdminToken string
	UserAgent  string
	Timeout    time.Duration
}

func NewClient(opts Options) *Client {
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	return &Client{
		endpoint:   strings.TrimRight(opts.Endpoint, "/"),
		adminToken: opts.AdminToken,
		userAgent:  opts.UserAgent,
		http:       &http.Client{Timeout: timeout},
	}
}

type APIError struct {
	Method string
	Path   string
	Status int
	Body   string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("fleet API %s %s -> %d: %s", e.Method, e.Path, e.Status, e.Body)
}

func IsNotFound(err error) bool {
	var ae *APIError
	if errorsAs(err, &ae) {
		return ae.Status == http.StatusNotFound
	}
	return false
}

// errorsAs is a tiny local replacement for errors.As to keep imports small.
func errorsAs(err error, target **APIError) bool {
	if err == nil {
		return false
	}
	if ae, ok := err.(*APIError); ok {
		*target = ae
		return true
	}
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
	if out == nil || len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return fmt.Errorf("decode %s %s: %w (body=%s)", method, path, err, string(raw))
	}
	return nil
}

// ---- DTOs -----------------------------------------------------------------

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

type AssembledConfig struct {
	Content       string   `json:"content"`
	Hash          string   `json:"hash"`
	PipelineNames []string `json:"pipeline_names"`
}

type ValidateResult struct {
	Valid  bool     `json:"valid"`
	Errors []string `json:"errors"`
	Engine string   `json:"engine,omitempty"`
}

type AuditEvent struct {
	ID         string         `json:"id"`
	CreatedAt  string         `json:"created_at"`
	Actor      string         `json:"actor"`
	Action     string         `json:"action"`
	TargetKind string         `json:"target_kind"`
	TargetID   *string        `json:"target_id"`
	TargetName *string        `json:"target_name"`
	Metadata   map[string]any `json:"metadata"`
}

// CatalogTemplateSummary is the lightweight shape returned by GET /catalog.
// It omits the Alloy `content` field; call GetCatalogTemplate to fetch it.
type CatalogTemplateSummary struct {
	ID              string            `json:"id"`
	Name            string            `json:"name"`
	Description     string            `json:"description"`
	Category        string            `json:"category"`
	Tags            []string          `json:"tags"`
	DefaultSelector map[string]string `json:"default_selector"`
	SuggestedName   *string           `json:"suggested_name"`
	DocsURL         *string           `json:"docs_url"`
	Requires        []string          `json:"requires"`
}

type CatalogTemplate struct {
	CatalogTemplateSummary
	Content string `json:"content"`
}

type CatalogListResponse struct {
	Sources   []string                 `json:"sources"`
	Templates []CatalogTemplateSummary `json:"templates"`
}

type CreatePipelineInput struct {
	Name     string            `json:"name"`
	Selector map[string]string `json:"selector"`
	Enabled  bool              `json:"enabled"`
	Content  string            `json:"content"`
}

// ---- Methods --------------------------------------------------------------

func (c *Client) ListPipelines(ctx context.Context) ([]Pipeline, error) {
	var out struct {
		Pipelines []Pipeline `json:"pipelines"`
	}
	if err := c.do(ctx, http.MethodGet, "/pipelines", nil, &out); err != nil {
		return nil, err
	}
	return out.Pipelines, nil
}

func (c *Client) GetPipeline(ctx context.Context, id string) (*PipelineDetail, error) {
	var out PipelineDetail
	if err := c.do(ctx, http.MethodGet, "/pipelines/"+url.PathEscape(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetPipelineByName resolves name -> detail using a client-side filter over
// the list endpoint. The server has no dedicated lookup-by-name route and
// pipelines are small enough that a full list is cheap.
func (c *Client) GetPipelineByName(ctx context.Context, name string) (*PipelineDetail, error) {
	list, err := c.ListPipelines(ctx)
	if err != nil {
		return nil, err
	}
	for _, p := range list {
		if p.Name == name {
			return c.GetPipeline(ctx, p.ID)
		}
	}
	return nil, &APIError{Method: http.MethodGet, Path: "/pipelines?name=" + name, Status: http.StatusNotFound, Body: "pipeline not found"}
}

func (c *Client) DeletePipeline(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodDelete, "/pipelines/"+url.PathEscape(id), nil, nil)
}

func (c *Client) Assemble(ctx context.Context, attrs map[string]string) (*AssembledConfig, error) {
	var out AssembledConfig
	body := map[string]any{"attributes": attrs}
	if err := c.do(ctx, http.MethodPost, "/pipelines/assemble", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Validate(ctx context.Context, content string) (*ValidateResult, error) {
	var out ValidateResult
	body := map[string]any{"content": content}
	if err := c.do(ctx, http.MethodPost, "/pipelines/validate", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
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

func (c *Client) CreatePipeline(ctx context.Context, in CreatePipelineInput) (*Pipeline, error) {
	var out Pipeline
	if err := c.do(ctx, http.MethodPost, "/pipelines", in, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ListCatalog(ctx context.Context) (*CatalogListResponse, error) {
	var out CatalogListResponse
	if err := c.do(ctx, http.MethodGet, "/catalog", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetCatalogTemplate(ctx context.Context, id string) (*CatalogTemplate, error) {
	var out struct {
		Template CatalogTemplate `json:"template"`
	}
	if err := c.do(ctx, http.MethodGet, "/catalog/"+url.PathEscape(id), nil, &out); err != nil {
		return nil, err
	}
	return &out.Template, nil
}

func (c *Client) ListAudit(ctx context.Context, q url.Values) ([]AuditEvent, error) {
	path := "/audit"
	if len(q) > 0 {
		path += "?" + q.Encode()
	}
	var out struct {
		Events []AuditEvent `json:"events"`
	}
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Events, nil
}
