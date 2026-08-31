# Production image for T3 Code app-prod stacks (see infra/compose/compose.app-prod.yml).
#
# Stage 1 installs the workspace and runs the same build the code-dev deploy
# script runs: `vp run --filter=t3 --filter=@t3tools/web build` with
# NODE_ENV=production and the VITE_HTTP_URL / VITE_WS_URL / VITE_DEV_SERVER_URL
# origins unset, so the bundle stays single-origin. Stage 2 copies the server
# bundle plus the installed node_modules; the bundle inlines the workspace but
# native packages (node-pty, msgpackr-extract, ...) stay external and resolve
# through the pnpm store, which is why the whole store comes along.

FROM node:24-bookworm-slim AS build

ENV CI=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1

# git for lockfile/prepare tooling; python3/make/g++ for node-gyp builds (node-pty).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Keep in sync with "packageManager" in the root package.json.
RUN npm install -g pnpm@11.10.0

WORKDIR /app

# Copy the (dockerignored) repo — prepare scripts (effect-tsgo patch, vp
# config) and patchedDependencies need the real layout, not just manifests.
COPY . .

RUN pnpm install --frozen-lockfile \
      --filter @t3tools/monorepo --filter "t3..." --filter "@t3tools/web..."

# Public build-time config. Per-stack hostnames must not be baked in.
ARG VITE_CODE_APP_DEV_STACKS_ENABLED
ENV VITE_CODE_APP_DEV_STACKS_ENABLED=${VITE_CODE_APP_DEV_STACKS_ENABLED}

RUN env -u VITE_HTTP_URL -u VITE_WS_URL -u VITE_DEV_SERVER_URL NODE_ENV=production \
      pnpm exec vp run --filter=t3 --filter=@t3tools/web build \
    && test -f apps/server/dist/bin.mjs \
    && test -f apps/server/dist/client/index.html

FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    T3CODE_NO_BROWSER=1

# git for checkpoints and worktrees; wget for the compose healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist

RUN mkdir -p /var/lib/t3code

EXPOSE 5733

CMD ["node", "apps/server/dist/bin.mjs", "serve", "--host", "0.0.0.0", "--port", "5733", "--base-dir", "/var/lib/t3code"]
