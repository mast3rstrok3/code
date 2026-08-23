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
- A workflow owns at most one stack that it created. Existing worktree stacks and standing
  deployments are reused without transferring ownership.
- If no namespace is supplied, T3 Code derives it from the worktree basename and appends `-dev`.
- The public frontend service should be named `web`, `frontend`, or `app`.
- The public API service should be named `api` or `backend`.
- Private services should set `stacks.appDevStack.expose: "false"` (legacy `cortex.appDevStack.*` and `rudi.appDevStack.*` still accepted).
- T3 Code derives preview URLs from the namespace and service name.
- The stack's namespace carries its identity as annotations, so any T3 Code server
  connected to the same cluster can name the stack and restart it from the right
  worktree: `cortex.ai/display-name`, `cortex.ai/display-slug`, `cortex.ai/repo-name`,
  `cortex.ai/branch-name`, `cortex.ai/worktree-path`, and `cortex.ai/compose-path`.

Conventional URLs:

| Service names            | URL                                               |
| ------------------------ | ------------------------------------------------- |
| `frontend`, `web`, `app` | `https://<namespace>.nightingale-ai.com`          |
| `backend`, `api`         | `https://api-<namespace>.nightingale-ai.com`      |
| `keycloak`               | `https://<namespace>-keycloak.nightingale-ai.com` |
| `minio`                  | `https://minio-<namespace>.nightingale-ai.com`    |

## Managing stacks

Open **App Stack** in the right sidebar to see every stack reported by the active environment. The
current worktree is marked and appears first. Stack cards start collapsed so the list stays compact;
expand a card to access previews, start and stop controls, service details, and Kubernetes pod logs.

Stacks created for a workflow are labeled **Workflow-owned**. If historical implementation runs
map more than one visible stack to the same workflow, the panel reports the conflict but never
deletes either stack automatically.

## Automatic teardown and protected stacks

When an engineering ticket succeeds, its ticket App Dev Stack starts tiering down at once. The
ticket carries that tier-down timestamp as durable desired state, so T3 Code sends the stop request
again after a restart or a temporary controller failure. The request scales the stack down without
waiting for its pods to finish terminating.

When the workflow succeeds, it protects and keeps the main shared App Dev Stack running, then tiers
down every other stack the workflow created. The run reports what it stopped in its activity log.
Stacks you started yourself are untouched, since no workflow owns them.

Expand a stack card and choose **Protect** to keep it out of general workflow teardown. A successful
engineering workflow still tiers down its ticket stacks and protects only its main shared stack.
A protected stack shows a **Protected** badge and is the last one the environment stops when the
host runs low on memory. Press the button again to release it. Protection does not change explicit
**Stop**, **Restart**, or **Delete** actions.

Under memory pressure an environment can also refuse to start new stacks and stop long-running ones
to keep the machine responsive. A stack stopped that way says so in the error line on its card, and
**Restart** brings it back once there is room.

A stopped stack keeps its namespace, so **Restart** brings it back up. Deleting a stack
removes its namespace, and the card leaves the list as soon as that namespace is gone —
including when another T3 Code server or the controller removed it. To clean up several stacks, select
their checkboxes (or use **Select all**) and choose **Delete** in the selection toolbar. T3 Code asks
for confirmation once, deletes the selected Kubernetes namespaces in parallel, and leaves any stack
that failed selected so you can retry it.

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

External controller mode (code-main; code-dev uses https://api-code-dev.nightingale-ai.com):

```bash
T3CODE_APP_DEV_STACK_BACKEND_URL=https://api-code.nightingale-ai.com
# Static service token accepted by the controller's app-dev-stack API
# (OpenBao: secret/cortex/t3code app_dev_stack_api_token; cortex-dev for code-dev).
T3CODE_APP_DEV_STACK_BACKEND_BEARER_TOKEN=...
```

The controller provisions stacks from this repo's `infra/compose/compose.app-dev.yml`
(services `frontend` + `backend`, single-origin dev proxy, hot reload in-pod).
Send `displayName: "code <branch>"` — it drives the preview hostnames
`code-<branch>-<service>-<shortuuid>[-dev].nightingale-ai.com`. If a stack for
the worktree/branch is already running the API answers `created: false` with
`alreadyRunning` and the existing URLs; branches served by the standing
deployments (`dev`, `main`) answer `reserved: true` with that deployment's URL
and never provision a duplicate stack.

Workflow orchestration sends its durable workflow ID when no existing worktree stack can be reused.
When that workflow later moves to another implementation worktree, the controller replaces only
the stack owned by that workflow. Shared, manual, and standing `dev`/`main` stacks are protected.
Completed and canceled workflows retain their latest stack for testing.
