# Shared dev image for T3 Code app dev stacks (see infra/compose/compose.app-dev.yml).
#
# A node+pnpm shell with the workspace's node_modules baked in. At runtime the
# worktree is bind-mounted over /app and the entrypoint restores the baked
# node_modules into the pod's emptyDir overlays (re-installing only when
# pnpm-lock.yaml changed), then execs the service's dev command.

FROM node:24-bookworm-slim AS base

ENV CI=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1

# git for lockfile/prepare tooling; python3/make/g++ for node-gyp builds
# (node-pty); wget for the compose healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 make g++ curl wget ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Keep in sync with "packageManager" in the root package.json.
RUN npm install -g pnpm@11.10.0

FROM base AS development

WORKDIR /app

# The entrypoint reuses the same filters for runtime installs. Root importer
# included so root devDeps (vite-plus, effect-tsgo) and prepare scripts work;
# desktop/mobile/marketing excluded (electron/expo downloads, never run here).
ENV PNPM_FILTERS="@t3tools/monorepo t3... @t3tools/web..." \
    APP_DIR=apps/web

# Copy the (dockerignored) repo — prepare scripts (effect-tsgo patch, vp
# config) and patchedDependencies need the real layout, not just manifests.
COPY . .

RUN pnpm install --frozen-lockfile \
      --filter @t3tools/monorepo --filter "t3..." --filter "@t3tools/web..."

# Stash root node_modules (contains the .pnpm virtual store) for fast restore
# into the pod's emptyDir overlay; stamp with the lockfile hash.
RUN cp -a node_modules /image-node-modules && \
    sha256sum pnpm-lock.yaml | cut -d' ' -f1 > /image-node-modules/.build-stamp

RUN cp infra/docker/app-dev/entrypoint.sh /entrypoint.sh && chmod +x /entrypoint.sh

EXPOSE 5733 13773

ENTRYPOINT ["/entrypoint.sh"]
CMD ["pnpm", "--filter", "@t3tools/web", "dev"]
