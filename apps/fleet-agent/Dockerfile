# syntax=docker/dockerfile:1.6
#
# LEGACY PATH ONLY. The primary deployment path is `remotecfg` running inside
# Alloy itself — see examples/bootstrap.alloy and docs/remotecfg.md.
#
# This Dockerfile packages the Node.js fleet-agent preserved in apps/fleet-agent
# for operators who want the REST pull model (e.g. they don't want Alloy to
# talk directly to the Fleet Manager). It is not the recommended path.

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/fleet-manager/package.json apps/fleet-manager/
COPY apps/fleet-agent/package.json apps/fleet-agent/

RUN npm ci --include=dev

COPY packages ./packages
COPY apps ./apps

RUN npm run build --workspace packages/shared \
 && npm run build --workspace apps/fleet-agent

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/fleet-agent/package.json apps/fleet-agent/
COPY --from=build /app/apps/fleet-agent/dist apps/fleet-agent/dist

RUN npm ci --omit=dev --workspaces --include-workspace-root

CMD ["node", "apps/fleet-agent/dist/index.js"]
