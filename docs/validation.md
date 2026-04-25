# Pipeline content validation

Bad Alloy syntax never reaches a collector: the Fleet Manager refuses
to persist a pipeline unless the content parses.

## Two layers

### 1. Builtin brace/quote check (always on)

A ~30-line in-process sweep that catches:

- unbalanced `{` / `}`
- unterminated string literals
- empty content

Fast, has no external dependencies, always runs first. Lives in
`apps/fleet-manager/src/services/validator.ts` as
`validateAlloyTemplate`.

### 2. `alloy fmt` strict check (enabled when the binary is present)

The manager shells out to `alloy fmt -`, feeding the pipeline content
on stdin. Exit code `0` means the parser accepted it; any other exit
means the parser rejected it, and stderr is surfaced as
`details[]` in the API response.

This catches everything the cheap check misses:

- invalid block types (`metrics.scrape` vs `prometheus.scrape`)
- unknown component names or arguments
- expression-level errors (`forward_to = [foo]` when `foo` is undefined)

The `alloy` binary is **baked into the `fleet-manager` Docker image**:

```dockerfile
COPY --from=grafana/alloy:latest /bin/alloy /usr/local/bin/alloy
```

Adds ~80MB to the image but means strict validation is on by default.

### Automatic fallback

If the `alloy` binary is missing at runtime (e.g. a slimmed-down image,
or a local `npm run dev:manager` without alloy on PATH), the strict
check transparently falls back to the builtin check. You'll see one
warning at startup:

```
[validator] strict validation DISABLED — 'alloy' not found. Pipeline writes will still run the builtin brace/quote check.
```

To enable strict validation locally, install Alloy from
[grafana.com/docs/alloy/latest/set-up/install](https://grafana.com/docs/alloy/latest/set-up/install/)
or point `FLEET_ALLOY_BIN` at the binary:

```bash
FLEET_ALLOY_BIN=/usr/local/bin/alloy npm run dev:manager
```

## API

```
POST /pipelines/validate
  Auth: Bearer <ADMIN_TOKEN>
  Body: { content: string }
  Response: { valid: boolean, errors: string[], engine: "alloy-fmt" | "builtin" }
```

Side-effect free — never touches the DB. Use it to gate `terraform
plan`, a git pre-commit hook, or a CI job.

## Where it runs

- **API write path:** `POST /pipelines` and `PATCH /pipelines/:id` both
  run `validateAlloyTemplateStrict` before touching the DB. A failed
  validation returns HTTP 400 with `{ error: "invalid_template",
  engine, details }`.
- **UI:** the pipeline form has a **Validate** button that hits
  `POST /pipelines/validate` without saving. Shows green/red inline.
- **CLI:** `fleetctl validate -f my.alloy` exits non-zero on
  validation failure — drop-in for CI pipelines.
- **Terraform:** the provider hits the same write path; validation
  errors come back as Terraform diagnostics.

## Why not `alloy run --dry-run`?

`alloy run` tries to instantiate components — opens sockets, reads
files from `FILE.*` arguments, resolves HTTP endpoints. That's
insecure and slow for a validation-only path. `alloy fmt` does only
lex + parse, which is exactly what we want.
