# App Stack agent prompt

Copy the prompt below into the coding agent that is working inside the target application
repository.

```text
You are preparing this repository so T3 Code can run it in an App Stack.

Outcome:
- The repository must contain a container entrypoint for the app.
- The repository must contain an App Stack manifest at infra/compose/compose.app-dev.yml.
- T3 Code must be able to start one isolated Kubernetes stack per worktree.
- The stack must expose the frontend at the URL that T3 Code derives for the worktree namespace.
- If this is a TanStack Start app, the TanStack Start server must run inside the App Stack.

Important constraints:
- Read the repository before editing. Do not guess the package manager, app framework, port, or
  build command.
- Do not hard-code a worktree name, namespace, or preview host in application code.
- Do not add secrets to Dockerfiles, compose files, or README examples.
- Prefer a production-style container for App Stack. Do not run a Vite dev server in the
  Kubernetes stack unless the repo explicitly has no production server yet.
- Preserve the repository's existing deployment setup. If the repo already has a deployment
  Dockerfile, add Dockerfile.app-dev instead of replacing it.

Discovery:
1. Identify the package manager from lockfiles:
   - pnpm-lock.yaml -> pnpm
   - bun.lock or bun.lockb -> bun
   - yarn.lock -> yarn
   - package-lock.json -> npm
2. Inspect package.json scripts and the app framework.
3. Identify the public app service, API service, worker services, and required ports.
4. Check whether the app is TanStack Start:
   - package.json contains @tanstack/react-start, or
   - vite.config.* imports @tanstack/react-start/plugin/vite.

TanStack Start requirements:
- The App Stack must run the built TanStack Start server, not only static files.
- Ensure package.json has a build script. For Vite-based TanStack Start this is usually:
  "build": "vite build"
- Add a start script for the App Stack when one is missing:
  "start:app-dev": "node .output/server/index.mjs"
- TanStack Start/Vinxi/Nitro commonly emits .output/server/index.mjs for the Node server. After
  running the build, verify the actual emitted server entry. If the path differs, use the emitted
  path and document it in the target repo README.
- The server must bind to 0.0.0.0 and respect PORT. In Docker and compose, set all of these unless
  the repo has a more precise framework-specific setting:
  HOST=0.0.0.0
  HOSTNAME=0.0.0.0
  NITRO_HOST=0.0.0.0
  PORT=3000
  NITRO_PORT=3000
- If the app is configured only for an edge adapter such as Cloudflare Workers, add an app-dev Node
  runtime path without breaking the existing edge deployment. The App Stack target is a
  Kubernetes container.
- Server functions run on the Node server. Put server-only configuration in non-VITE environment
  variables. Only use VITE_ variables for values that are safe to bake into the client build.

Dockerfile requirements:
1. Add Dockerfile.app-dev unless a suitable Dockerfile already exists.
2. Use the detected package manager. Do not mix package managers.
3. Use a multi-stage build:
   - dependency install stage
   - build stage
   - runtime stage
4. The runtime stage must:
   - set NODE_ENV=production
   - set HOST/HOSTNAME/NITRO_HOST to 0.0.0.0
   - set PORT/NITRO_PORT to the service port
   - expose the same container port used by the app-dev compose file
   - start the production server
5. For a TanStack Start app using pnpm, this is the expected shape. Adapt only where the repository
   requires it:

   FROM node:22-bookworm-slim AS base
   WORKDIR /app
   ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
   RUN corepack enable

   FROM base AS deps
   COPY package.json pnpm-lock.yaml ./
   RUN pnpm install --frozen-lockfile

   FROM deps AS build
   COPY . .
   RUN pnpm run build

   FROM node:22-bookworm-slim AS runner
   WORKDIR /app
   ENV NODE_ENV=production
   ENV HOST=0.0.0.0
   ENV HOSTNAME=0.0.0.0
   ENV NITRO_HOST=0.0.0.0
   ENV PORT=3000
   ENV NITRO_PORT=3000
   COPY --from=build /app/.output ./.output
   EXPOSE 3000
   CMD ["node", ".output/server/index.mjs"]

6. For npm, yarn, or bun, keep the same runtime contract but replace install/build commands with
   the repo's package manager.
7. Add or update .dockerignore so Docker does not copy local artifacts:
   node_modules
   .git
   .output
   dist
   build
   coverage
   .env
   .env.*
   worktrees
   userdata
   caches

App Stack manifest requirements:
1. Create infra/compose/compose.app-dev.yml.
2. Treat this file as T3 Code's App Stack manifest. It is docker-compose-shaped YAML, but T3
   Code uses it to generate Kubernetes resources.
3. Name the public frontend service web, frontend, or app. Prefer web for a single TanStack Start
   frontend.
4. Name the public API service api or backend when it needs a public preview URL.
5. Mark workers and private support services with stacks.appDevStack.expose: "false" (legacy cortex.appDevStack.* and rudi.appDevStack.* labels are still accepted).
6. Include image for every service.
7. Include build for services that should be built from this repo.
8. Include ports for every service that must get a Kubernetes Service or preview route.
9. Put only non-secret configuration in environment.
10. For frontend-to-backend calls, prefer same-origin routes or internal Kubernetes service URLs
    such as http://api:4000. Do not bake a preview host into the frontend build.

Use this TanStack Start manifest shape for a single frontend service:

services:
  web:
    image: app-web:latest
    build:
      context: ../..
      dockerfile: Dockerfile.app-dev
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      HOSTNAME: 0.0.0.0
      NITRO_HOST: 0.0.0.0
      PORT: "3000"
      NITRO_PORT: "3000"
    ports:
      - "3000:3000"
    labels:
      stacks.appDevStack.expose: "true"

If the repo has an API service, add it like this and update commands/Dockerfile names to match the
repo:

  api:
    image: app-api:latest
    build:
      context: ../..
      dockerfile: Dockerfile.api
    environment:
      NODE_ENV: production
      HOST: 0.0.0.0
      PORT: "4000"
    ports:
      - "4000:4000"

If the repo has workers, add them without preview routing:

  worker:
    image: app-worker:latest
    build:
      context: ../..
      dockerfile: Dockerfile.worker
    labels:
      stacks.appDevStack.expose: "false"

URL and namespace contract:
- T3 Code derives the Kubernetes namespace from the selected worktree basename.
- Example: /home/nils/repos/nils/hero -> hero-dev.
- The frontend URL for service web/frontend/app is:
  https://<namespace>.nightingale-ai.com
- The API URL for service api/backend is:
  https://api-<namespace>.nightingale-ai.com
- Keycloak, if present, is:
  https://<namespace>-keycloak.nightingale-ai.com
- MinIO, if present, is:
  https://minio-<namespace>.nightingale-ai.com
- Do not hard-code those URLs in the repo. The App Stack system owns them.

Repository README note:
Add a short section called "App Stack" that states:
- The manifest path is infra/compose/compose.app-dev.yml.
- T3 Code derives one namespace per worktree.
- The public frontend service is web and listens on port 3000.
- For TanStack Start apps, App Stack runs the built server at .output/server/index.mjs.
- Required non-secret environment variables, if any.

Validation:
1. Run the repo's normal install command if dependencies are missing.
2. Run the repo's normal typecheck/test/build commands that already exist.
3. Run the app-dev build command directly, for example:
   pnpm run build
4. Verify the TanStack Start server entry exists after build when applicable:
   test -f .output/server/index.mjs
5. Validate Docker:
   docker build -f Dockerfile.app-dev -t app-dev-test .
6. Validate the container listens on the expected port:
   docker run --rm -p 3000:3000 app-dev-test
   curl -fsS http://127.0.0.1:3000/
7. Validate compose syntax when docker compose is available:
   docker compose -f infra/compose/compose.app-dev.yml config

Final response:
- List files changed.
- State the exact app-dev frontend service name and port.
- State the exact Dockerfile used by compose.
- State the exact production command run in the container.
- State which validation commands passed.
- If any validation could not be run, say exactly why.
```

## Why these instructions are strict

TanStack Start applications are full-stack servers, not static SPAs. The App Stack must run the
server output so SSR, server functions, and server routes work. Current TanStack Start deployment
guidance describes Start as a full-stack framework with server functions and SSR, and common Node
deployments use the generated `.output/server/index.mjs` server entry.

The App Stack also relies on service names and worktree-derived namespaces for predictable
preview URLs. The target repository should describe services and container entrypoints; T3 Code and
the App Stack controller own namespace creation and public hostnames.

## Optional: a prod contract

If the repository should also support prod stacks (the production build, no source mounts), add
`infra/compose/compose.app-prod.yml` next to the dev one: same schema, but each service points at
a multi-stage Dockerfile that builds the release and runs it, with no worktree bind mounts and no
dev-server environment. It is only used when a stack is started with the Prod variant.

## References

- TanStack Start hosting guide: https://tanstack.com/start/v0/docs/framework/react/guide/hosting
- Railway TanStack Start Docker deployment guide:
  https://docs.railway.com/guides/tanstack-start
- Cloudflare TanStack Start guide, useful for edge-runtime projects that may need a separate
  app-dev Node target: https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/
