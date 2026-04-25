#!/usr/bin/env bash
# 0-to-100 end-to-end test driver.
#
# What this script does, in order:
#   1. Sanity-check the host (docker/podman, terraform, jq, go, curl).
#   2. (optional) Tear down any prior compose state for a clean slate.
#   3. Build the Terraform provider binary and wire up dev_overrides.
#   4. Bring up the docker-compose stack with the `with-alloy` profile.
#   5. Wait for the manager's /health to flip to "ok".
#   6. terraform apply -auto-approve in terraform/examples/e2e.
#   7. Verify everything end-to-end:
#        a. The 3 pipelines are present.
#        b. The agent api token (RBAC path) authenticates against remotecfg.
#        c. The legacy AGENT_BEARER_TOKEN still authenticates (back-compat).
#        d. The agent token is REJECTED on /pipelines (RBAC scoping).
#        e. Alloy registered itself with the manager.
#        f. prom-sink received samples (proves the assembled config works).
#   8. (optional) Teardown.
#
# Knobs (env vars):
#   ENABLE_TEARDOWN=0              don't run `compose down -v` at the end (default 1)
#   ENABLE_INITIAL_TEARDOWN=0      skip the pre-apply teardown step (default 1)
#   COMPOSE_BIN="..."              force a specific compose CLI. Auto-detected
#                                  if unset: tries `docker compose`,
#                                  then `podman compose`, then `podman-compose`,
#                                  then `docker-compose` (legacy v1).
#   FLEET_ENDPOINT=...             default http://localhost:9090
#   ADMIN_TOKEN=...                default change-me-admin-token (matches .env.example)
#   AGENT_BEARER_TOKEN=...         default change-me-agent-bearer-token
#   PROM_SINK_URL=...              default http://localhost:9091
#
# Exit code is the first failing step, so CI can fail fast and you can
# inspect the relevant docker logs.
set -euo pipefail

# ---- locate repo root -------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# ---- knobs ------------------------------------------------------------------
ENABLE_TEARDOWN="${ENABLE_TEARDOWN:-1}"
ENABLE_INITIAL_TEARDOWN="${ENABLE_INITIAL_TEARDOWN:-1}"
# COMPOSE_BIN may be set by the user to force a specific CLI. If unset we
# auto-detect below in the preflight phase. Multi-word values like
# "docker compose" are word-split where used (`$COMPOSE_BIN ...`), so the
# variable must NOT be quoted at call sites.
COMPOSE_BIN="${COMPOSE_BIN:-}"

FLEET_ENDPOINT="${FLEET_ENDPOINT:-http://localhost:9090}"
ADMIN_TOKEN="${ADMIN_TOKEN:-change-me-admin-token}"
AGENT_BEARER_TOKEN="${AGENT_BEARER_TOKEN:-change-me-agent-bearer-token}"
PROM_SINK_URL="${PROM_SINK_URL:-http://localhost:9091}"

EXAMPLE_DIR="terraform/examples/e2e"
PROVIDER_DIR="terraform/provider-fleet"
DEV_TFRC="$REPO_ROOT/terraform/dev.tfrc"

# ---- pretty printing --------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[1;34m'
YELLOW='\033[0;33m'
DIM='\033[2m'
RESET='\033[0m'

step()  { printf "\n${BLUE}== %s ==${RESET}\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$*"; }
fail()  { printf "${RED}✗${RESET} %s\n" "$*" >&2; exit 1; }
info()  { printf "${DIM}  %s${RESET}\n" "$*"; }

trap 'rc=$?; if [ $rc -ne 0 ]; then printf "\n${RED}✗ e2e test failed (exit %d)${RESET}\n" "$rc" >&2; fi' EXIT

# ---- 1. host sanity check ---------------------------------------------------
step "1. host preflight"

need() {
  local cmd="$1" hint="${2:-}"
  command -v "$cmd" >/dev/null 2>&1 || fail "missing required tool: $cmd${hint:+ ($hint)}"
}
need terraform "https://terraform.io"
need go        "https://go.dev/dl"
need jq        "brew install jq / apt install jq"
need curl

# Compose CLI auto-detection. Each candidate is probed by running
# `<candidate> version`, redirecting BOTH stdout and stderr — `docker compose`
# on a host without a running daemon, for instance, exits 0 but writes to
# stderr; we don't care, presence of the subcommand is enough.
#
# Order is deliberate:
#   1. `docker compose`  — modern Docker (v2 plugin); most CI runners.
#   2. `podman compose`  — Podman 4.4+ ships its own native subcommand.
#   3. `podman-compose`  — older Podman releases via the Python wrapper.
#   4. `docker-compose`  — legacy Docker Compose v1 standalone binary.
detect_compose() {
  if [ -n "$COMPOSE_BIN" ]; then
    # Operator forced a specific CLI; honour it without overrides but verify
    # it actually works so we fail in this preflight phase rather than mid-run.
    if ! $COMPOSE_BIN version >/dev/null 2>&1; then
      fail "COMPOSE_BIN='$COMPOSE_BIN' is set but '$COMPOSE_BIN version' failed"
    fi
    return 0
  fi

  local candidates=(
    "docker compose"
    "podman compose"
    "podman-compose"
    "docker-compose"
  )
  local cand
  for cand in "${candidates[@]}"; do
    # First word of `cand` is the binary; subsequent words are subcommand args.
    # We need both `command -v <bin>` (not multi-word safe) AND a full smoke
    # test (`$cand version`) — the latter catches edge cases like `docker`
    # being installed without the compose plugin.
    local bin="${cand%% *}"
    if command -v "$bin" >/dev/null 2>&1 && $cand version >/dev/null 2>&1; then
      COMPOSE_BIN="$cand"
      return 0
    fi
  done

  fail "no compose CLI found. Install Docker Desktop, or Podman 4.4+ (\`podman compose\`), or set COMPOSE_BIN to a working command."
}
detect_compose

ok "all required tools found"
info "compose CLI: $COMPOSE_BIN"
info "terraform:   $(terraform version | head -n1)"
info "go:          $(go version)"

# ---- 2. optional initial teardown ------------------------------------------
# When we wipe the postgres volume, EVERY uuid in the local Terraform state
# becomes invalid. The next `apply` would then call Refresh on those stale
# ids and the manager would 500 on the uuid-cast (or 404, depending on
# resource). So compose teardown and local-state teardown MUST happen
# together — never independently.
if [ "$ENABLE_INITIAL_TEARDOWN" = "1" ]; then
  step "2. tearing down any prior compose state + local terraform state"
  $COMPOSE_BIN --profile with-alloy down -v --remove-orphans >/dev/null 2>&1 || true
  rm -f "$EXAMPLE_DIR"/terraform.tfstate \
        "$EXAMPLE_DIR"/terraform.tfstate.backup \
        "$EXAMPLE_DIR"/.terraform.lock.hcl
  rm -rf "$EXAMPLE_DIR"/.terraform
  ok "compose + tfstate reset"
else
  warn "ENABLE_INITIAL_TEARDOWN=0; keeping compose volumes AND local tfstate (run only after a clean apply, otherwise they will diverge)"
fi

# ---- 3. build the provider + wire dev_overrides ----------------------------
step "3. building Terraform provider"
( cd "$PROVIDER_DIR" && go build -o terraform-provider-fleet . )
ok "built $PROVIDER_DIR/terraform-provider-fleet"

# Generate a dev.tfrc on the fly so this script doesn't depend on whatever the
# operator may have committed locally. We deliberately overwrite each run.
cat > "$DEV_TFRC" <<EOF
provider_installation {
  dev_overrides {
    "fleet-oss/fleet" = "$REPO_ROOT/$PROVIDER_DIR"
  }
  direct {}
}
EOF
export TF_CLI_CONFIG_FILE="$DEV_TFRC"
ok "wired TF_CLI_CONFIG_FILE -> $DEV_TFRC"

# ---- 4. bring up the compose stack -----------------------------------------
step "4. bringing up docker-compose (postgres + fleet-manager + alloy + prom-sink)"
$COMPOSE_BIN --profile with-alloy up -d --build
ok "compose up -d completed"

# ---- 5. wait for the manager to be healthy ---------------------------------
step "5. waiting for fleet-manager /health"
deadline=$(( $(date +%s) + 120 ))
while :; do
  if curl -sf -m 2 "$FLEET_ENDPOINT/health" >/dev/null 2>&1; then
    ok "manager healthy at $FLEET_ENDPOINT"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    info "fleet-manager logs (last 80 lines):"
    $COMPOSE_BIN logs --tail=80 fleet-manager || true
    fail "fleet-manager did not become healthy within 120s"
  fi
  sleep 2
done

# ---- 6. terraform apply ----------------------------------------------------
step "6. terraform apply"
export FLEET_ENDPOINT
export FLEET_ADMIN_TOKEN="$ADMIN_TOKEN"

# `terraform init` is a no-op under dev_overrides but Terraform still emits a
# loud warning. Skip it entirely to keep the script output readable.
terraform -chdir="$EXAMPLE_DIR" apply -auto-approve
ok "terraform apply succeeded"

# Capture outputs we need for verification.
AGENT_TOKEN="$(terraform -chdir="$EXAMPLE_DIR" output -raw agent_token)"
AGENT_TOKEN_PREFIX="$(terraform -chdir="$EXAMPLE_DIR" output -raw agent_token_prefix)"
PIPELINE_NAMES_JSON="$(terraform -chdir="$EXAMPLE_DIR" output -json pipeline_names)"

[ -n "$AGENT_TOKEN" ] || fail "agent_token output was empty"
ok "agent token minted (prefix: $AGENT_TOKEN_PREFIX)"

# ---- 7. end-to-end verification --------------------------------------------
step "7a. all 3 expected pipelines exist"
for want in base-remote-write base-self-metrics edge-metrics; do
  echo "$PIPELINE_NAMES_JSON" | jq -e --arg n "$want" 'index($n) != null' >/dev/null \
    || fail "expected pipeline '$want' not present (got: $PIPELINE_NAMES_JSON)"
  ok "$want present"
done

step "7b. agent api token authenticates against remotecfg (RBAC path)"
HTTP="$(curl -s -o /tmp/e2e-getconfig.json -w '%{http_code}' \
  -X POST "$FLEET_ENDPOINT/collector.v1.CollectorService/GetConfig" \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"e2e-probe","local_attributes":{"env":"dev","role":"edge"},"hash":""}')"
[ "$HTTP" = "200" ] || { cat /tmp/e2e-getconfig.json; fail "GetConfig with agent token returned HTTP $HTTP"; }
# The response body is either {"content":"...","hash":"..."} on first poll, or
# {"notModified":true} on a repeat. Both prove the auth path worked.
jq -e '.content != null or .notModified == true' /tmp/e2e-getconfig.json >/dev/null \
  || fail "GetConfig response shape unexpected: $(cat /tmp/e2e-getconfig.json)"
ok "agent token GetConfig succeeded"

step "7c. legacy AGENT_BEARER_TOKEN still works (back-compat)"
HTTP="$(curl -s -o /tmp/e2e-getconfig-legacy.json -w '%{http_code}' \
  -X POST "$FLEET_ENDPOINT/collector.v1.CollectorService/GetConfig" \
  -H "Authorization: Bearer $AGENT_BEARER_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"e2e-probe","local_attributes":{"env":"dev","role":"edge"},"hash":""}')"
[ "$HTTP" = "200" ] || { cat /tmp/e2e-getconfig-legacy.json; fail "GetConfig with legacy token returned HTTP $HTTP"; }
ok "legacy token GetConfig succeeded"

step "7d. agent token is REJECTED on /pipelines (RBAC scoping)"
HTTP="$(curl -s -o /dev/null -w '%{http_code}' \
  -H "Authorization: Bearer $AGENT_TOKEN" \
  "$FLEET_ENDPOINT/pipelines")"
# The agent role has only collectors.poll, so reading pipelines must 403.
[ "$HTTP" = "403" ] || fail "expected 403 on GET /pipelines with agent token, got $HTTP"
ok "agent token correctly forbidden from /pipelines (HTTP 403)"

step "7e. Alloy has registered with the manager"
# Wait up to ~90s for Alloy's first poll. Fresh Alloy boot + remotecfg
# poll_frequency=30s means the first registration usually arrives within
# 30-45s, but cold-start image pulls can push it further out.
deadline=$(( $(date +%s) + 90 ))
while :; do
  COLLECTORS="$(curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$FLEET_ENDPOINT/remotecfg/collectors" || true)"
  if [ -n "$COLLECTORS" ] && echo "$COLLECTORS" | jq -e '.collectors | length > 0' >/dev/null 2>&1; then
    ok "Alloy registered with the manager"
    info "$(echo "$COLLECTORS" | jq -c '[.collectors[] | {id, last_status}]')"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    info "fleet-alloy logs (last 60 lines):"
    $COMPOSE_BIN logs --tail=60 alloy || true
    fail "Alloy did not register within 90s"
  fi
  sleep 3
done

step "7f. prom-sink is receiving samples (proves the pipeline is live)"
# Wait for the first scrape interval (15s) plus a bit of margin. We query
# the `up` metric — generated by every Prometheus-compatible scraper. If
# any series with that name exist, samples are flowing.
deadline=$(( $(date +%s) + 120 ))
while :; do
  RESP="$(curl -sf "$PROM_SINK_URL/api/v1/query?query=up" || true)"
  if echo "$RESP" | jq -e '.data.result | length > 0' >/dev/null 2>&1; then
    # NB: escape the backticks around 'up' — inside a double-quoted bash
    # string they trigger command substitution (bash tries to exec `up`,
    # which prints `line N: up: command not found` mid-success message).
    ok "prom-sink has $(echo "$RESP" | jq '.data.result | length') series for \`up\`"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    info "prom-sink response: $RESP"
    info "fleet-alloy logs (last 60 lines):"
    $COMPOSE_BIN logs --tail=60 alloy || true
    fail "prom-sink received no samples within 120s — assembled config likely incorrect"
  fi
  sleep 3
done

# ---- 7g. drift-free re-apply ----------------------------------------------
step "7g. re-apply produces zero drift"
PLAN_OUT="$(terraform -chdir="$EXAMPLE_DIR" plan -detailed-exitcode -no-color 2>&1)" && PLAN_RC=0 || PLAN_RC=$?
# Exit code 0 = no diff, 2 = diff present, 1 = error.
case "$PLAN_RC" in
  0) ok "second plan reports zero drift (idempotent apply)" ;;
  2) printf "%s\n" "$PLAN_OUT"; fail "second plan proposes changes — provider is not idempotent" ;;
  *) printf "%s\n" "$PLAN_OUT"; fail "second plan errored (rc=$PLAN_RC)" ;;
esac

# ---- 8. teardown -----------------------------------------------------------
if [ "$ENABLE_TEARDOWN" = "1" ]; then
  step "8. tearing down"
  terraform -chdir="$EXAMPLE_DIR" destroy -auto-approve >/dev/null
  ok "terraform destroy completed"
  $COMPOSE_BIN --profile with-alloy down -v --remove-orphans >/dev/null
  ok "compose down -v completed"
else
  warn "ENABLE_TEARDOWN=0; leaving the stack and Terraform state in place"
  info "manager:    $FLEET_ENDPOINT"
  info "ui:         $FLEET_ENDPOINT/ui/  (or http://localhost:5173 if running npm run dev:ui)"
  info "prom-sink:  $PROM_SINK_URL"
  info "to clean up later: $COMPOSE_BIN --profile with-alloy down -v"
fi

printf "\n${GREEN}all e2e checks passed${RESET}\n"
