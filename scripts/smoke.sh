#!/usr/bin/env bash
# Manual smoke test against a running docker-compose stack.
#   docker compose up -d postgres
#   npm run migrate
#   npm run seed
#   npm run dev:manager     # in another terminal
#   scripts/smoke.sh
set -euo pipefail

URL="${FLEET_MANAGER_URL:-http://localhost:9090}"
ADMIN_TOKEN="${ADMIN_TOKEN:-change-me-admin-token}"
AGENT_BEARER_TOKEN="${AGENT_BEARER_TOKEN:-change-me-agent-bearer-token}"

say() { printf "\n\033[1;34m== %s ==\033[0m\n" "$*"; }

say "GET /health"
curl -sf "$URL/health" | jq .

say "GET /pipelines (admin)"
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/pipelines" | jq '.pipelines[] | {name, current_version, selector, enabled}'

say "POST /collector.v1.CollectorService/RegisterCollector (JSON)"
curl -sf -X POST "$URL/collector.v1.CollectorService/RegisterCollector" \
  -H "Authorization: Bearer $AGENT_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"smoke-test-host","name":"smoke","local_attributes":{"env":"dev","role":"edge"}}' \
  | jq .

say "POST /collector.v1.CollectorService/GetConfig (edge)"
curl -sf -X POST "$URL/collector.v1.CollectorService/GetConfig" \
  -H "Authorization: Bearer $AGENT_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"smoke-test-host","local_attributes":{"env":"dev","role":"edge"}}' \
  | jq .

say "POST /collector.v1.CollectorService/GetConfig (not-edge: should only match base-logging)"
curl -sf -X POST "$URL/collector.v1.CollectorService/GetConfig" \
  -H "Authorization: Bearer $AGENT_BEARER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"id":"smoke-test-host","local_attributes":{"env":"dev","role":"other"}}' \
  | jq .

say "GET /remotecfg/collectors"
curl -sf -H "Authorization: Bearer $ADMIN_TOKEN" "$URL/remotecfg/collectors" | jq .

say "OK"
