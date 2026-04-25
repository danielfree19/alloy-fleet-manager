# Contributing to Alloy Fleet Manager (OSS)

Thanks for considering a contribution. This project is Apache-2.0 licensed
and is developed primarily on **GitLab** — GitHub is a read-only mirror
that is updated automatically by CI on every push and tag.

> Source of truth:    https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager
> GitHub mirror:      https://github.com/fleet-oss/alloy-fleet-manager
> Issues / MRs / CI:  on **GitLab**

If you discover a bug or have a feature idea, please **open an issue on
GitLab** rather than a GitHub issue — the GitHub mirror is configured to
disable issue tracking and will not be monitored.

---

## Ways to contribute

- **Report a bug** — open a GitLab issue using the *Bug* template.
- **Propose a feature** — open a GitLab issue using the *Feature* template.
- **Send a merge request** — fork on GitLab, push a branch, open an MR
  using the default MR template. The CI pipeline will run automatically.
- **Add a template to the catalog** — see
  [`docs/catalog.md`](docs/catalog.md). New entries land in
  `catalog/templates.json`; please include a self-contained example and
  a one-line summary of what the pipeline does.
- **Improve the docs** — anything under `docs/`. Markdown only, no
  generated content.

## Local development

The repo is a single npm workspace plus two Go modules. The `Makefile`s
under `cmd/fleetctl` and `terraform/provider-fleet` are the canonical
entry points for the Go side; everything else is `npm run …` from the
root.

```bash
# clone, then:
cp .env.example .env
docker compose up -d postgres
npm install
npm run build --workspace packages/shared
npm run migrate
npm run seed

# in two terminals:
npm run dev:manager
npm run dev:ui

# Go bits:
( cd cmd/fleetctl && make build )
( cd terraform/provider-fleet && make build )
```

A full end-to-end smoke (compose + Terraform + a real Alloy instance +
Prometheus sink) lives at `scripts/e2e-terraform.sh`. CI runs it on
release tags; you can run it locally any time:

```bash
bash scripts/e2e-terraform.sh
```

See [`docs/development.md`](docs/development.md) for more.

## Coding rules of the road

- **Don't rewrite working logic.** Open an issue first if a refactor is
  load-bearing — small additive changes are far easier to review and
  land. (This rule lives in `CLAUDE.md` too because it's important.)
- **No silent behaviour changes.** If your MR changes an API contract,
  the audit log shape, the migration sequence, or the `remotecfg` poll
  protocol, call it out at the top of the MR description.
- **Migrations are append-only.** Never edit a migration that has
  already been merged to `main`. Add a new one.
- **Tests / smoke updates.** If you touch the auth, RBAC, audit, or
  remotecfg code paths, please extend `scripts/e2e-terraform.sh` or
  add a test that exercises the change.
- **TypeScript over JavaScript** for new files in `apps/` and
  `packages/`. Go for new files in `cmd/` and `terraform/`.
- **Conventional Commits.** Tag types we accept:
  `feat`, `fix`, `docs`, `chore`, `refactor`, `ci`, `test`, `build`,
  `perf`, `revert`. The CHANGELOG is regenerated from the commit log
  at release time, so the prefix matters.

## Sign-off (DCO)

Every commit must carry a `Signed-off-by:` line — the
[Developer Certificate of Origin](https://developercertificate.org/) —
which says you wrote the patch (or have the right to contribute it)
and license it under Apache-2.0. `git commit -s` adds the trailer
automatically.

```
git commit -s -m "feat: add fleetctl logs --follow"
```

The CI pipeline blocks MRs whose commits are missing the sign-off.

## Reporting a security vulnerability

**Do not** open a public issue for a security report. See
[`SECURITY.md`](SECURITY.md) for the disclosure process.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to abide by it.

## License

By contributing you agree that your contributions are licensed under the
Apache License, Version 2.0 (see [`LICENSE`](LICENSE)). The DCO sign-off
is the formal mechanism by which you affirm this.
