# syntax=docker/dockerfile:1.6

# Build stage: install + compile all workspaces (we need the shared package
# built, the fleet-manager compiled, and the fleet-ui bundled).
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Copy workspace manifests first for better layer caching.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/fleet-manager/package.json apps/fleet-manager/
COPY apps/fleet-agent/package.json apps/fleet-agent/
COPY apps/fleet-ui/package.json apps/fleet-ui/

RUN npm ci --include=dev

# Now copy sources and build.
COPY packages ./packages
COPY apps ./apps
COPY proto ./proto
COPY catalog ./catalog

RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/fleet-manager \
 && npm run build --workspace apps/fleet-ui

# ---------------------------------------------------------------------------
# Runtime stage: only prod deps + compiled JS + the vendored proto + UI dist.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# OCI image labels so registry UIs (Docker Hub, GitLab Container Registry,
# GHCR if we ever push there) show source/license/version info correctly.
# CI overrides org.opencontainers.image.version and .revision per build.
LABEL org.opencontainers.image.title="Alloy Fleet Manager" \
      org.opencontainers.image.description="Self-hosted fleet management for Grafana Alloy collectors" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager" \
      org.opencontainers.image.url="https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager" \
      org.opencontainers.image.documentation="https://gitlab.thepcport.com/fleet-oss/alloy-fleet-manager/-/blob/main/README.md" \
      org.opencontainers.image.vendor="The Fleet OSS Authors"

# The `alloy` binary is baked in so we can invoke `alloy fmt` in a subprocess
# to validate pipeline content at write time. We pull from the upstream
# grafana/alloy image rather than downloading the tarball so we inherit any
# required dynamic linker tweaks. Adds ~80MB to the final image; worth it
# for catching syntax errors before they reach a collector.
#
# If the `alloy` binary is missing at runtime (e.g. a slimmed image) the
# validator falls back to the braces/quotes sanity check. See services/validator.ts.
COPY --from=grafana/alloy:latest /bin/alloy /usr/local/bin/alloy

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/fleet-manager/package.json apps/fleet-manager/
COPY --from=build /app/apps/fleet-manager/dist apps/fleet-manager/dist
# Migrations are sql files and tsc doesn't copy them.
COPY --from=build /app/apps/fleet-manager/src/db/migrations apps/fleet-manager/dist/db/migrations
# The proto file is loaded at runtime; must be on disk at the path proto.ts expects.
COPY --from=build /app/proto proto
# Template catalog: loaded at startup by catalog/loader.ts. Same repo-root-relative
# layout as the proto files, so no path rewriting is needed.
COPY --from=build /app/catalog catalog
# Static UI bundle; the manager serves this at /ui/ via @fastify/static.
# A minimal package.json keeps `apps/fleet-ui` a recognized workspace entry
# in the runtime image even though we don't install its deps.
COPY --from=build /app/apps/fleet-ui/package.json apps/fleet-ui/
COPY --from=build /app/apps/fleet-ui/dist apps/fleet-ui/dist

RUN npm ci --omit=dev --workspaces --include-workspace-root

EXPOSE 9090
# Run migrations, then start the API.
# Use `npx --no-install` so we don't depend on PATH or on where exactly
# node-pg-migrate ends up (hoisted root node_modules vs workspace-local).
CMD ["sh", "-c", "npx --no-install node-pg-migrate -m apps/fleet-manager/dist/db/migrations -j sql up && node apps/fleet-manager/dist/index.js"]
