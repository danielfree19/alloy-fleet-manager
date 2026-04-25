# Release process

This document is the recipe for cutting a new release. The pipeline
that does the heavy lifting is documented in
[`docs/ci-cd.md`](ci-cd.md); start there if you want to know **how**
something gets built. This page is the **operator's checklist**.

> Every artifact is shipped from a single Git tag. Tag formatting
> matters: the pipeline matches `^v\d+\.\d+\.\d+/` (with optional
> `-pre.N` suffix). Anything else is treated as a regular branch push.

## TL;DR

```bash
# 1. Bump version + changelog on a release branch.
git checkout -b release/v0.2.0
sed -i 's/"version": ".*"/"version": "0.2.0"/' packages/sdk/package.json
$EDITOR CHANGELOG.md         # promote [Unreleased] to [0.2.0] - YYYY-MM-DD
git commit -sa -m "chore(release): v0.2.0"

# 2. Open and merge the MR.
glab mr create --fill && glab mr merge --squash

# 3. Tag main and push.
git checkout main && git pull
git tag -s v0.2.0 -m "v0.2.0"
git push origin v0.2.0

# 4. Watch the `release` and `mirror` stages turn green:
glab pipeline status

# 5. Verify (see the verification section at the bottom).
```

Total wall-time from `git push origin v0.2.0` to "users can install
v0.2.0 from npm and the Terraform Registry" is typically 10–15 minutes.

## What gets published, and where

| Artifact                              | Source                                    | Destination                                                     |
| ------------------------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| `fleet-manager` container image       | `apps/fleet-manager/Dockerfile`           | `$CI_REGISTRY_IMAGE/fleet-manager:<version>` (GitLab) + Docker Hub if `DOCKERHUB_USERNAME` is set |
| `terraform-provider-fleet_*_*.zip`    | `terraform/provider-fleet/`               | GitLab generic package + (after first-time onboarding) Terraform Registry |
| `terraform-provider-fleet_*_SHA256SUMS` (+ `.sig`) | GoReleaser, GPG-signed         | Same as above                                                   |
| `fleetctl_*_*.tar.gz` / `.zip`        | `cmd/fleetctl/`                           | GitLab generic package, GitHub Releases (via mirror)            |
| `@fleet-oss/sdk@<version>`            | `packages/sdk/`                           | npm public registry                                             |
| All refs + tags                       | The whole repo                            | `github.com/fleet-oss/alloy-fleet-manager` (mirror)             |

Operator install snippets are in [`README.md`](../README.md) and the
per-component docs (`docs/terraform.md`, `docs/fleetctl.md`,
`docs/sdk.md`).

## Pre-release checklist

Before tagging, every box must be ticked:

- [ ] **`packages/sdk/package.json#version` matches the tag.** The
      `release:sdk:npm` job hard-fails if these disagree, so this
      catches itself, but it's faster to fix it before pushing.
- [ ] **`CHANGELOG.md` has a populated entry for this version**, with
      `## [X.Y.Z] - YYYY-MM-DD` and the appropriate Added/Changed/
      Fixed/Security subsections. The `## [Unreleased]` section is
      reset to empty.
- [ ] **`scripts/e2e-terraform.sh` passes locally** on the commit
      you're about to tag. (CI will re-run it, but local feedback
      is faster.)
- [ ] **No DB migration was edited** since the last tag. If a
      migration changed, that's a breaking-change release and the
      MR needs explicit reviewer sign-off.
- [ ] **`docs/`** updated for any new flag, env var, or RBAC
      permission introduced in this cycle.
- [ ] **CLAUDE.md** has its "Last updated" line bumped, with a one-
      line summary of the release.

## Tagging

We use **signed annotated tags** so the GitHub mirror's "Verified"
badge lights up:

```bash
git tag -s v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

If you don't have a Git signing key set up, see
<https://docs.gitlab.com/ee/user/project/repository/signed_commits/>.

## What CI does next

The pipeline triggered by the tag runs:

1. `lint` + `build` + `test` (same as on every push).
2. `smoke:e2e-terraform`.
3. **All four** release jobs in parallel:
   - `release:docker:fleet-manager`
   - `release:provider:goreleaser`
   - `release:fleetctl:goreleaser`
   - `release:sdk:npm`
4. `mirror:github`.

Each release job is independent. If, say, the npm job fails because
the registry is down, the docker push and Terraform provider release
still succeed. Re-run only the failed job from the GitLab UI:

```
Settings → CI/CD → Pipelines → <the failing pipeline> → "↻ Retry"
                                                       on the failed job
```

## First-time setup: Terraform Registry onboarding

The Registry trusts a GPG fingerprint, not a username, so this is a
one-time task:

1. Sign in at <https://registry.terraform.io> with a GitHub account
   that owns the namespace (`fleet-oss`). The Registry pulls release
   metadata from **GitHub**, which is why we maintain the mirror.
2. Click **Publish → Provider** and pick the
   `fleet-oss/terraform-provider-fleet` repository.
3. Upload the **public** half of the GPG key whose fingerprint is in
   `GPG_FINGERPRINT` (see [`docs/ci-cd.md`](ci-cd.md)). The Registry
   stores the fingerprint and refuses any future release whose
   `SHA256SUMS.sig` doesn't verify against it.
4. The Registry then polls the GitHub mirror's **Releases** page on
   every webhook ping. Our pipeline doesn't currently *create* a
   GitHub Release object directly — the mirror only pushes refs and
   tags. To bridge the gap on the first release:
   - install the [release-please-bot](https://github.com/googleapis/release-please)
     **on the mirror only** (read-only access; it just upgrades a tag
     into a Release page) **or**
   - create the Release manually once via `gh release create vX.Y.Z`,
     pulling the `terraform/provider-fleet/dist/*` artifacts down from
     the GitLab pipeline and re-uploading. Subsequent releases are
     identical, so a 5-line shell script + `glab pipeline get-artifact`
     handles it.

If you don't want to publish to the public Terraform Registry yet, the
artifacts in the GitLab generic package are usable directly via a
[`network_mirror`](https://developer.hashicorp.com/terraform/cli/config/config-file#network_mirror)
config block — your `~/.terraformrc` can point at:

```
provider_installation {
  network_mirror {
    url = "https://gitlab.com/api/v4/projects/<project-id>/packages/generic/terraform-provider-fleet/"
  }
}
```

## First-time setup: npm scope

The `@fleet-oss` scope on npmjs.org needs to exist and grant publish
rights to the CI's `NPM_TOKEN`. To set it up once:

```bash
npm login                              # human, MFA-protected
npm org create fleet-oss               # if not already created
npm token create --read-only=false     # paste into GitLab NPM_TOKEN var
                                       # (mark Masked + Protected)
npm access grant read-write fleet-oss:developers @fleet-oss/sdk
```

After that, the pipeline does the rest on every tag.

## Verifying a release

Once the pipeline turns green:

```bash
# 1. Container image
docker pull registry.gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/fleet-manager:0.2.0
docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.version" }}' \
  registry.gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/fleet-manager:0.2.0
# → 0.2.0

# 2. Terraform provider
mkdir tf-verify && cd tf-verify
cat > main.tf <<'EOF'
terraform {
  required_providers {
    fleet = { source = "fleet-oss/fleet", version = "0.2.0" }
  }
}
EOF
terraform init     # pulls the provider, verifies the GPG signature

# 3. fleetctl
curl -sSL https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/-/releases/v0.2.0/downloads/fleetctl_0.2.0_linux_amd64.tar.gz \
  | tar -xz fleetctl
./fleetctl --version

# 4. SDK
npm view @fleet-oss/sdk@0.2.0
```

## Hotfix / patch releases

For an urgent fix off a previous minor:

```bash
git checkout v0.1.5
git checkout -b release/v0.1.6
# ... cherry-pick or write the fix ...
git commit -sa -m "fix: ..."
git tag -s v0.1.6 -m "v0.1.6"
git push origin release/v0.1.6 v0.1.6
```

The pipeline runs on the tag exactly the same way; the branch push is
only there so the fix is reachable for future cherry-picks.

## Yanking a bad release

If a release went out broken:

1. **Don't delete the tag.** Yanking is metadata, not deletion —
   downstream pinning would break.
2. **`npm deprecate`** the SDK version with the reason:
   ```bash
   npm deprecate @fleet-oss/sdk@0.2.0 "0.2.0 was broken; use 0.2.1"
   ```
3. For the **Docker image** push a `:0.2.0` overwrite that's actually
   `0.2.1`'s code (or pull the tag from public registries with `docker
   trust …` if you set up notary; we do not, today).
4. For the **Terraform provider** there is no formal yank flow — the
   Registry only honours signed releases. Push `0.2.1` immediately and
   announce in the GitLab release notes that `0.2.0` is unsupported.
5. **Edit `CHANGELOG.md`** to note the yank under the original
   version's section.

## Communication

Once everything is green:

- Update the GitLab Release page (`/-/releases`) with the
  `CHANGELOG.md` excerpt + the artifact links.
- Drop a one-liner in the project chat / mailing list.
- If the release contains a `Security` entry, follow
  [`SECURITY.md`](../SECURITY.md) for the disclosure timing.
