#!/bin/sh
# App-dev entrypoint: sync node_modules from the image into the pod's emptyDir
# overlay (re-linking the bind-mounted worktree's importers), then exec the
# dev command. Adapted from rudi's infra/docker/frontend/entrypoint.sh.
set -e

IMAGE_STAMP=""
CURRENT_STAMP=""
VOLUME_STAMP=""

# Space-separated pnpm --filter selectors set by the Dockerfile so runtime
# installs stay scoped to the same packages as the image's install.
FILTER_ARGS=""
if [ -n "${PNPM_FILTERS:-}" ]; then
  for filter in $PNPM_FILTERS; do
    FILTER_ARGS="$FILTER_ARGS --filter $filter"
  done
fi

if [ -f "/image-node-modules/.build-stamp" ]; then
  IMAGE_STAMP=$(cat /image-node-modules/.build-stamp)
fi

if [ -f "pnpm-lock.yaml" ]; then
  CURRENT_STAMP=$(sha256sum pnpm-lock.yaml | cut -d' ' -f1)
fi

TARGET_STAMP="${CURRENT_STAMP:-$IMAGE_STAMP}"

# Use .ready-stamp (not .build-stamp) to mark a COMPLETED install.
# .build-stamp gets copied from the image but doesn't prove pnpm install finished.
if [ -f "node_modules/.ready-stamp" ]; then
  VOLUME_STAMP=$(cat node_modules/.ready-stamp)
fi

# rm -rf node_modules/* leaves dotfiles (.pnpm, .modules.yaml, pnpm's
# workspace-state file) behind; stale state from a previous install then makes
# pnpm skip re-linking the workspace importers. Clear everything.
clear_node_modules() {
  find node_modules -mindepth 1 -maxdepth 1 -exec rm -rf {} +
}

# A pnpm install can report success yet leave the app's importer node_modules
# without its symlinks (stale pre-existing state makes pnpm skip re-linking).
# The dev server is started via the importer's .bin, so require it.
importer_linked() {
  [ -z "${APP_DIR:-}" ] && return 0
  [ -d "$APP_DIR/node_modules/.bin" ]
}

install_from_scratch() {
  echo "Installing dependencies from scratch..."
  clear_node_modules
  CI=true pnpm install --no-frozen-lockfile $FILTER_ARGS
  echo "${TARGET_STAMP:-fresh-install}" > node_modules/.ready-stamp
}

if [ -z "$VOLUME_STAMP" ] || [ "$TARGET_STAMP" != "$VOLUME_STAMP" ] || ! importer_linked; then
  if [ -d "/image-node-modules" ] && [ -n "$(ls -A /image-node-modules 2>/dev/null)" ]; then
    echo "Syncing node_modules from image (image stamp: ${IMAGE_STAMP:-none}, current stamp: ${CURRENT_STAMP:-none})..."
    clear_node_modules
    cp -a /image-node-modules/. node_modules/
    # Re-link workspace packages — the .pnpm store is already populated from
    # the image copy above, so this only creates symlinks (fast, no downloads).
    echo "Linking workspace packages..."
    if CI=true pnpm install --frozen-lockfile $FILTER_ARGS && importer_linked; then
      # Mark as fully ready only after pnpm install succeeds
      echo "${TARGET_STAMP:-fresh-install}" > node_modules/.ready-stamp
    else
      # Recover from a corrupted store index ("database disk image is
      # malformed") or an install that skipped importer linking — clean
      # install instead of crash-looping / serving a broken app.
      echo "pnpm install after image sync failed or left importers unlinked — retrying with a clean install..."
      install_from_scratch
    fi
  else
    install_from_scratch
  fi
fi

exec "$@"
