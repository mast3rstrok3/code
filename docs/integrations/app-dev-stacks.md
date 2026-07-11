# App Dev Stack integration

T3 Code can start a Kubernetes App Dev Stack for a selected worktree. The target application
repository must provide an app-dev container entrypoint and a manifest at:

```text
infra/compose/compose.app-dev.yml
```

For setup work in another repository, copy the full prompt in
[App Dev Stack agent prompt](./app-dev-stack-agent-prompt.md).

## Contract summary

- One worktree maps to one Kubernetes namespace.
- If no namespace is supplied, T3 Code derives it from the worktree basename and appends `-dev`.
- The public frontend service should be named `web`, `frontend`, or `app`.
- The public API service should be named `api` or `backend`.
- Private services should set `cortex.appDevStack.expose: "false"`.
- T3 Code derives preview URLs from the namespace and service name.

Conventional URLs:

| Service names            | URL                                               |
| ------------------------ | ------------------------------------------------- |
| `frontend`, `web`, `app` | `https://<namespace>.nightingale-ai.com`          |
| `backend`, `api`         | `https://api-<namespace>.nightingale-ai.com`      |
| `keycloak`               | `https://<namespace>-keycloak.nightingale-ai.com` |
| `minio`                  | `https://minio-<namespace>.nightingale-ai.com`    |

## TanStack Start

For TanStack Start repositories, the App Dev Stack should run the built server, not a Vite dev
server. The common Node runtime entry is:

```text
.output/server/index.mjs
```

The container must bind to `0.0.0.0` and respect `PORT`. Set `HOST`, `HOSTNAME`, `NITRO_HOST`,
`PORT`, and `NITRO_PORT` in the app-dev Dockerfile and compose manifest unless the target repo has a
more precise runtime-specific setup.

## T3 Code configuration

Native local Kubernetes mode:

```bash
T3CODE_APP_DEV_STACK_NATIVE_ENABLED=true
T3CODE_APP_DEV_STACK_NATIVE_COMPOSE_PATH=infra/compose/compose.app-dev.yml
T3CODE_APP_DEV_STACK_NATIVE_IMAGE_REGISTRY=harbor.nightingale-ai.com
```

External controller mode:

```bash
T3CODE_APP_DEV_STACK_BACKEND_URL=https://api-code.nightingale-ai.com
```
