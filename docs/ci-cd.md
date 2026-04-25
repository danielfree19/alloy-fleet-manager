# CI/CD pipeline

This project's continuous-integration pipeline lives in
[`.gitlab-ci.yml`](../.gitlab-ci.yml). GitLab is the source of truth;
GitHub at <https://github.com/danielfree19/alloy-fleet-manager> is a
read-only mirror updated by the `mirror:github` job.

> If you only want to **release** a new version, jump straight to
> [`docs/release.md`](release.md). This document is for the people who
> maintain the pipeline itself.

## At a glance

```
                ┌────────────┐
 push / MR ───▶ │   lint     │ DCO sign-off, yaml lint
                └─────┬──────┘
                      ▼
                ┌────────────┐
                │   build    │ npm typecheck + build,
                │            │ go vet + go build (provider, fleetctl)
                └─────┬──────┘
                      ▼
                ┌────────────┐
                │   test     │ manager smoke-boot against a live postgres,
                │            │ provider unit tests, fleetctl unit tests
                └─────┬──────┘
                      ▼
       (default branch + tags only)
                ┌────────────┐
                │   smoke    │ scripts/e2e-terraform.sh against compose
                └─────┬──────┘
                      ▼
              (tags v*.*.* only)
                ┌────────────┐
                │  release   │ docker buildx push (multi-arch),
                │            │ goreleaser provider (GPG-signed),
                │            │ goreleaser fleetctl, npm publish SDK
                └─────┬──────┘
                      ▼
                ┌────────────┐
                │   mirror   │ git push --mirror github
                └────────────┘
```

`interruptible: true` is set on every job, so a fresh push to an MR
auto-cancels the previous pipeline.

## Required CI variables

Configure these under **Settings → CI/CD → Variables** in the GitLab
project. Mark every secret as **Masked** *and* **Protected** (only
exposed to protected branches/tags). Anything in *italics* is optional.

| Variable                | Used by                                 | Notes |
| ----------------------- | --------------------------------------- | ----- |
| `CI_REGISTRY_*`         | docker push                             | Provided by GitLab automatically. Nothing to set. |
| *`DOCKERHUB_USERNAME`*  | docker push (mirror to Docker Hub)      | Leave unset if you only want to push to GitLab Container Registry. |
| *`DOCKERHUB_TOKEN`*     | docker push (mirror to Docker Hub)      | Pair with the username above. |
| `GPG_PRIVATE_KEY`       | `release:provider:goreleaser`           | ASCII-armored secret key, one big multi-line variable. **Required** for the Terraform provider release (the Registry rejects unsigned `SHA256SUMS`). |
| `GPG_PASSPHRASE`        | `release:provider:goreleaser`           | Passphrase for the key above. |
| `NPM_TOKEN`             | `release:sdk:npm`                       | "Automation" token for the `@fleet-oss` npm scope. |
| `GITHUB_DEPLOY_KEY`     | `mirror:github`                         | base64-encoded ed25519 private key. The matching public key is added as a **deploy key** on the GitHub mirror with **Allow write access** ticked. |
| `GITHUB_MIRROR_URL`     | `mirror:github`                         | e.g. `github.com/danielfree19/alloy-fleet-manager.git`. |
| *`NIGHTLY`*             | `smoke:e2e-terraform` (schedule)        | Set to `"true"` on a Pipeline Schedule for nightly e2e runs. |
| *`NIGHTLY_MIRROR`*      | `mirror:github` (schedule)              | Set to `"true"` on a separate Pipeline Schedule if you want a once-a-day mirror push regardless of repository activity. |

### Generating the GPG key for the Terraform provider

Run this **on a trusted machine**, not inside the CI runner:

```bash
gpg --full-generate-key                   # RSA 4096, no expiry
gpg --list-secret-keys --keyid-format=long
gpg --export-secret-keys --armor <FPR>    # paste this into GPG_PRIVATE_KEY
gpg --export --armor <FPR> > public.asc   # upload this to the Terraform Registry
```

The Terraform Registry [signing-keys
endpoint](https://developer.hashicorp.com/terraform/registry/api-docs#list-signing-keys-for-a-namespace)
needs `public.asc`. Once accepted, that fingerprint is the only one
that can sign `terraform-provider-fleet_*_SHA256SUMS` releases — keep
the private half in a password manager *and* a hardware backup.

### Generating the GitHub mirror deploy key

```bash
ssh-keygen -t ed25519 -f mirror_key -C 'gitlab-ci-mirror' -N ''
base64 -w0 mirror_key       # paste into GITHUB_DEPLOY_KEY
cat mirror_key.pub          # paste into GitHub repo Settings → Deploy keys
                            # (tick "Allow write access")
```

The job `ssh-keyscan github.com` at runtime, so you do **not** need a
`KNOWN_HOSTS` variable.

## Stage-by-stage walkthrough

### `lint`

- **`lint:dco`** — refuses MRs whose commits are missing a
  `Signed-off-by:` trailer. See [`CONTRIBUTING.md`](../CONTRIBUTING.md).
  Skipped on direct pushes to `main` (you can't sign a commit you
  don't own). Use a pre-receive hook on the GitLab side if you want
  to enforce sign-off there too.
- **`lint:yaml`** — `yamllint` over every YAML file we ship. Catches
  tab/space mixing in `docker-compose.yml`, `examples/sso.yaml.example`,
  the GoReleaser configs, etc. Config is `.yamllint.yml`.

### `build`

- **`build:node`** — `npm ci`, `npm run typecheck`, `npm run build`
  across all workspaces. Caches `node_modules` keyed by
  `package-lock.json`. Artifacts (`dist/`s) are passed to the test
  stage so we don't recompile.
- **`build:provider`** — `go vet` + `go build` for the Terraform
  provider. Cache key is `terraform/provider-fleet/go.sum`.
- **`build:fleetctl`** — same shape as above for `cmd/fleetctl`.

### `test`

- **`test:manager:smoke-boot`** — boots `apps/fleet-manager` against a
  sibling postgres service, runs `npm run migrate && npm run seed`,
  hits `/health` and `/auth/providers`. Catches:
  - migrations that fail under a clean DB,
  - the SSO YAML loader exploding at boot (regression test for the
    "manager refuses to start on bad sso.yaml" bug),
  - the seed script regressing.
- **`test:provider:unit`** / **`test:fleetctl:unit`** — `go test`,
  `count=1` to disable the cache, 5 minute timeout.

### `smoke` *(default branch + tags + nightly only)*

- **`smoke:e2e-terraform`** — runs `bash scripts/e2e-terraform.sh`
  inside Docker-in-Docker. The script exits non-zero if:
  - any of the three demo pipelines is missing,
  - the agent's RBAC token can't authenticate against `remotecfg`,
  - the legacy `AGENT_BEARER_TOKEN` stops working,
  - the agent token is **not** rejected on `/pipelines` (RBAC scope
    check),
  - Alloy doesn't register within 90 seconds,
  - the prom-sink doesn't see a single sample within 120 seconds,
  - a second `terraform plan` reports drift.

  We deliberately don't run this on every MR — it's a 10–15 min job.
  When something breaks, it's the first place to look.

### `release` *(tag `v*.*.*` only)*

Each job is independent — a failure in one (e.g. expired GPG key) does
not block the others. Re-run them individually from the GitLab UI.

- **`release:docker:fleet-manager`** — `docker buildx` for both
  `linux/amd64` and `linux/arm64`, pushed to
  `$CI_REGISTRY_IMAGE/fleet-manager:<version>` and `:latest`. If
  `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` are set the same image is
  also pushed to Docker Hub. OCI labels (`org.opencontainers.image.*`)
  are added at build time so the image's "Source" link in registry
  UIs points at the GitLab repo.
- **`release:provider:goreleaser`** — runs goreleaser in
  `terraform/provider-fleet/`. Cross-builds for the full Terraform
  Registry matrix, computes SHA256, GPG-signs `SHA256SUMS`, and emits
  a `terraform-provider-fleet_*_manifest.json` carrying the
  `protocol_versions` declaration. The artifacts are exposed under
  the GitLab release page; see `docs/release.md` for how to wire them
  to `registry.terraform.io`.
- **`release:fleetctl:goreleaser`** — same shape for the CLI but
  without GPG signing (no registry requires it).
- **`release:sdk:npm`** — verifies that
  `packages/sdk/package.json#version` matches the tag, then
  `npm publish --access public --provenance` to the public npm
  registry. The `--provenance` flag publishes a Sigstore-signed
  attestation linking the npm package to this CI pipeline run.

### `mirror`

- **`mirror:github`** — `git push --mirror`. The `--mirror` flag
  pushes every ref (branches + tags + notes) and **prunes** refs that
  have been deleted on GitLab, making GitHub a true mirror rather
  than an accumulating shadow.

  If `GITHUB_DEPLOY_KEY` or `GITHUB_MIRROR_URL` is missing the job
  exits 0 with a "skipping" log line so it's safe to land this
  pipeline before you've configured the mirror.

- **`wiki:sync:gitlab`** and **`wiki:sync:github`** — auto-publish the
  contents of `docs/` (plus `CONTRIBUTING.md`, `SECURITY.md`,
  `CHANGELOG.md`, `CODE_OF_CONDUCT.md`, `MAINTAINERS.md`) to the
  project's GitLab Wiki and the GitHub mirror's Wiki on every default-
  branch push and every tag.

  The wiki tree is built by `scripts/build-wiki.sh`, which:
  - copies each `docs/*.md` into a flat layout (wiki page slugs have
    no folders);
  - rewrites `[…](docs/foo.md)` and `[…](foo.md)` into wiki-style
    `[…](foo)` so cross-references resolve;
  - prepends an "auto-synced from `docs/`, do not edit here" banner to
    every page;
  - generates `Home.md` from the README's "## Docs" section, plus
    `_sidebar.md` (GitLab) and `_Sidebar.md` (GitHub) for navigation.

  Both jobs force-overwrite the wiki repo on each push, so manual edits
  in the wiki UI are clobbered on the next CI run — the banner warns
  about this. To change wiki content, edit `docs/` and merge.

  Auth for `wiki:sync:gitlab` uses a project access token
  (`GITLAB_WIKI_TOKEN`) with `write_repository` scope and Maintainer
  access — `CI_JOB_TOKEN` is rejected by GitLab's wiki ACL with
  `403 You are not allowed to write to this project's wiki`. Create
  and upload via:

  ```bash
  glab token create --access-level maintainer --scope write_repository \
    --duration 360d fleet-oss-wiki-sync \
    | glab variable set GITLAB_WIKI_TOKEN --protected --masked --raw
  ```

  Rotate yearly with:

  ```bash
  glab token rotate fleet-oss-wiki-sync --duration 360d \
    | glab variable update GITLAB_WIKI_TOKEN --protected --masked --raw
  ```

  Auth for `wiki:sync:github` reuses `GITHUB_DEPLOY_KEY` (the same key
  the mirror job uses) — GitHub deploy keys with write access can
  push to the repo's `.wiki.git`. **One-time bootstrap on GitHub**:
  enable Wikis under Settings → Features, then visit the Wiki tab and
  click "Create the first page" so the `.wiki.git` repo actually
  exists. Until that's done the job logs a "Bootstrap:" hint and
  fail-soft skips.

  Local dry-run:
  ```bash
  ./scripts/build-wiki.sh
  ls wiki-build/    # 28 pages: docs/* + Home + _sidebar + a few root files
  ```

## Local pipeline dry-runs

You can sanity-check a job without pushing:

```bash
# YAML lint
yamllint -c .yamllint.yml .

# Build (with cached node_modules from a prior install)
npm run typecheck && npm run build

# Manager smoke-boot
docker compose up -d postgres
npm run migrate && npm run seed
node apps/fleet-manager/dist/index.js &
curl -sf http://localhost:9090/health

# e2e
bash scripts/e2e-terraform.sh

# GoReleaser
( cd terraform/provider-fleet && goreleaser release --snapshot --skip=publish,sign --clean )
( cd cmd/fleetctl              && goreleaser release --snapshot --skip=publish      --clean )
```

## Known gaps / future work

- **Container image signing.** Cosign + a Fulcio keyless cert via the
  `release:docker:*` job is queued — needs a stable repo URL and
  Sigstore tenant decision first.
- **SBOMs.** GoReleaser already emits SBOMs for the Go binaries when
  `sbom:` is added to the config; we'll wire that in once we have
  somewhere durable to host them.
- **Helm chart publishing.** Roadmap, not in this iteration.
- **Self-hosted runner.** The DinD smoke job will get faster on a
  warm-cache self-hosted runner; SaaS shared runners are fine for
  the rest.
