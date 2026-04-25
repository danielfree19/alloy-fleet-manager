<!--
This is the public read-only mirror of
https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager.

External PRs are welcome here. A maintainer will reconcile accepted
changes back into the source repository, preserving authorship and the
DCO sign-off.
-->

### What

<!-- Describe what this PR changes, in one or two short paragraphs.
Use the *imperative* voice ("Add support for X") matching Conventional
Commits — the title and merge commit are derived from this. -->

### Why

<!-- Why is this change worth doing? Link the GitHub issue if there is
one (`Closes #123`). -->

### How

<!-- Implementation summary. Call out any non-obvious choices, anything
load-bearing the reviewer should look at first, and anything you
explicitly chose NOT to do (and why). -->

### Compatibility

- [ ] No breaking change to the public API (`/pipelines`, `/auth/*`, the
      `collector.v1.CollectorService` RPC, `/auth/me` shape, audit log
      shape, etc.)
- [ ] No breaking change to the Terraform provider schema
- [ ] No breaking change to the SDK's exported types
- [ ] DB migrations are append-only (no edits to merged migration files)

If any of the above are unchecked, describe the migration path here.

### Test plan

<!-- What did you actually run? Tick the ones that apply, fill in the
"Manual verification" with the exact steps if relevant. -->

- [ ] `npm run typecheck && npm run build` clean
- [ ] `npm run dev:manager` boots, `/health` is green
- [ ] `bash scripts/smoke.sh` passes
- [ ] `bash scripts/e2e-terraform.sh` passes locally
- [ ] `( cd cmd/fleetctl && make test )` passes
- [ ] `( cd terraform/provider-fleet && make test )` passes

#### Manual verification

```
<!-- paste the commands you ran, or the curl invocations, or the
screenshots of the UI change -->
```

### Checklist

- [ ] All commits are signed off (DCO — `git commit -s`)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
- [ ] Docs updated where relevant (`docs/`, `README.md`, `CLAUDE.md`)
- [ ] No new dependency added without justifying it in the PR description
