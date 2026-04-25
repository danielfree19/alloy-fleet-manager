#!/usr/bin/env bash
# Build a flat wiki tree from docs/* + selected root docs.
#
# Output goes to $OUT_DIR (default: wiki-build/), which is what the
# wiki:sync:gitlab and wiki:sync:github CI jobs push to the respective
# wiki repos. The directory is wiped at the start of every run.
#
# What this does:
#   1. Copies every docs/*.md into OUT_DIR/, stripping the .md path
#      prefix (wiki page slugs have no folders).
#   2. Rewrites internal links so they resolve in the wiki:
#        [x](docs/foo.md)        -> [x](foo)
#        [x](foo.md)             -> [x](foo)
#        [x](foo.md#anchor)      -> [x](foo#anchor)
#   3. Prepends a "synced from docs/, do not edit here" banner so the
#      wiki UI doesn't mislead drive-by editors.
#   4. Emits Home.md (the wiki landing page) by lifting the "## Docs"
#      section from README.md.
#   5. Emits _sidebar.md (GitLab) and _Sidebar.md (GitHub) for nav.
#
# Local dry-run:
#
#   ./scripts/build-wiki.sh
#   ls wiki-build/

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="${OUT_DIR:-$ROOT/wiki-build}"
SRC_BLOB_BASE="${SRC_BLOB_BASE:-https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/-/blob/main}"

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# Files at repo root that should also surface in the wiki. Page slug =
# uppercase root file (CONTRIBUTING -> Contributing) so they don't
# collide with docs/* (lowercase-with-hyphens).
declare -a ROOT_PAGES=(
  "CONTRIBUTING.md:Contributing.md"
  "SECURITY.md:Security.md"
  "CHANGELOG.md:Changelog.md"
  "CODE_OF_CONDUCT.md:Code-of-Conduct.md"
  "MAINTAINERS.md:Maintainers.md"
)

# Rewrite md links so they resolve as wiki page slugs.
# Two passes: first strip docs/ prefix, then strip .md suffix on
# relative refs. Anchors (#section) survive both.
rewrite_links() {
  sed -E \
    -e 's#\]\(docs/([^)]+)\.md([)#])#](\1\2#g' \
    -e 's#\]\(([a-zA-Z0-9_-]+)\.md([)#])#](\1\2#g' \
    -e 's#\[docs/([a-zA-Z0-9_-]+)\.md\]#[\1]#g'
}

# Prepend a "this is auto-synced" banner. $1 = source path (relative
# to repo root) for the deep-link back to GitLab.
prepend_banner() {
  local src="$1" dst="$2"
  {
    printf '> **Auto-synced from [`%s`](%s/%s).** Edit there, not here — wiki edits are overwritten on the next CI run.\n\n---\n\n' \
      "$src" "$SRC_BLOB_BASE" "$src"
    cat "$dst.tmp"
  } > "$dst"
  rm -f "$dst.tmp"
}

# 1. docs/*.md  ->  OUT_DIR/<slug>.md
for src in "$ROOT"/docs/*.md; do
  base="$(basename "$src")"
  rel="docs/$base"
  out="$OUT_DIR/$base"
  rewrite_links < "$src" > "$out.tmp"
  prepend_banner "$rel" "$out"
done

# 2. Selected root docs.
for spec in "${ROOT_PAGES[@]}"; do
  src_name="${spec%%:*}"
  dst_name="${spec##*:}"
  src="$ROOT/$src_name"
  out="$OUT_DIR/$dst_name"
  if [[ -f "$src" ]]; then
    rewrite_links < "$src" > "$out.tmp"
    prepend_banner "$src_name" "$out"
  fi
done

# 3. Home.md — lift the "## Docs" section from README.md and rewrite
#    its links. Anything before "## Docs" or after the next "## " is
#    dropped; the wiki landing page is intentionally just the index.
home_body="$(awk '
  /^## Docs[[:space:]]*$/ { in_docs=1; next }
  in_docs && /^## / { in_docs=0 }
  in_docs { print }
' "$ROOT/README.md" | rewrite_links | sed -E \
    -e 's#\[docs/([a-zA-Z0-9_-]+)\.md\]#[\1]#g' \
    -e 's#\[CONTRIBUTING\.md\]\(CONTRIBUTING(\.md)?\)#[Contributing](Contributing)#g' \
    -e 's#\[SECURITY\.md\]\(SECURITY(\.md)?\)#[Security](Security)#g' \
    -e 's#\[CHANGELOG\.md\]\(CHANGELOG(\.md)?\)#[Changelog](Changelog)#g' \
    -e '/CLAUDE\.md/d')"

cat > "$OUT_DIR/Home.md" <<EOF
# Fleet Manager — Wiki

Self-hosted, vendor-neutral replacement for Grafana Cloud Fleet
Management. This wiki is auto-synced from the [\`docs/\`](${SRC_BLOB_BASE}/docs)
directory in the source repository on every push to \`main\`. **Do not
edit pages here directly** — open a merge request against \`docs/\`
instead. Wiki edits are overwritten on the next CI run.

## Documentation

${home_body}

## Source

- GitLab (canonical): ${SRC_BLOB_BASE%/-/blob/main}
- GitHub (read-only mirror): see [\`docs/ci-cd.md\`](ci-cd)
EOF

# 4. Sidebar — same nav, terser. Both filenames so it works on GitLab
#    (_sidebar.md) and GitHub (_Sidebar.md).
sidebar_body() {
  cat <<'EOF'
**[Home](Home)**

**Operate**
- [Architecture](architecture)
- [Deployment](deployment)
- [Development](development)
- [CI/CD](ci-cd)
- [Release](release)

**Identity**
- [Auth & RBAC](auth)
- [Auth testing](auth-testing)
- [SSO (OIDC)](sso)
- [Audit log](audit)

**Pipelines**
- [remotecfg (primary)](remotecfg)
- [Legacy agent](legacy-agent)
- [Validation](validation)
- [Catalog](catalog)

**Surfaces**
- [API](api)
- [UI](ui)
- [UI state](state)
- [Terraform](terraform)
- [SDK](sdk)
- [fleetctl](fleetctl)

**Data**
- [Data model](data-model)

**Testing**
- [E2E (Terraform)](e2e-terraform)

**Project**
- [Contributing](Contributing)
- [Security](Security)
- [Changelog](Changelog)
- [Code of Conduct](Code-of-Conduct)
- [Maintainers](Maintainers)
EOF
}

sidebar_body > "$OUT_DIR/_sidebar.md"
sidebar_body > "$OUT_DIR/_Sidebar.md"

echo "✓ wiki built: $OUT_DIR ($(find "$OUT_DIR" -type f -name '*.md' | wc -l | tr -d ' ') pages)"
