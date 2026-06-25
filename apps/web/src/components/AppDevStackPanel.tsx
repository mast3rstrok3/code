import {
  type AppDevStack,
  type AppDevStackService,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BoxesIcon,
  CornerLeftUpIcon,
  ExternalLinkIcon,
  FolderIcon,
  LoaderIcon,
  PlayIcon,
  PlusIcon,
  PowerIcon,
  RefreshCwIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { ensureBrowseDirectoryPath, getBrowseParentPath } from "~/lib/projectPaths";
import { cn } from "~/lib/utils";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appDevStackEnvironment } from "~/state/appDevStacks";
import { filesystemEnvironment } from "~/state/filesystem";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Button } from "./ui/button";
import { Input } from "./ui/input";

const TRANSITIONING_STATUSES = new Set(["pending", "starting", "stopping"]);
const PRIMARY_PREVIEW_SERVICE_NAMES = ["frontend-dev", "frontend", "web"] as const;

interface AppDevStackPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly activeThread: {
    readonly branch: string | null;
    readonly worktreePath: string | null;
  } | null;
  readonly activeProject: {
    readonly title: string;
    readonly workspaceRoot: string;
    readonly environmentId: EnvironmentId;
  };
  readonly workspaceRoot: string;
  readonly gitCwd: string | null;
  readonly openPreview: OpenPreviewMutation;
}

interface PreviewCandidate {
  readonly serviceName: string;
  readonly url: string;
}

interface StartPathChoice {
  readonly label: string;
  readonly path: string;
}

function normalizeWorktreePath(path: string): string {
  return path.trim().replace(/\/+$/u, "") || path.trim();
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function displayNameFromPath(worktreePath: string): string {
  const normalized = normalizeWorktreePath(worktreePath);
  const lastSlashIndex = normalized.lastIndexOf("/");
  return normalized.slice(lastSlashIndex + 1) || "App dev stack";
}

function displayStackName(stack: AppDevStack): string {
  return (
    stack.displayName?.trim() || stack.repoName?.trim() || displayNameFromPath(stack.worktreePath)
  );
}

function stackUpdatedTime(stack: AppDevStack): number {
  const timestamp = Date.parse(stack.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function stackRepoBranchLabel(stack: AppDevStack): string | null {
  const repo = nonEmpty(stack.repoName);
  const branch = nonEmpty(stack.branchName);
  if (repo && branch) return `${repo} / ${branch}`;
  return repo ?? branch;
}

function collectPreviewCandidates(stack: AppDevStack): readonly PreviewCandidate[] {
  const candidates: PreviewCandidate[] = [];
  const seen = new Set<string>();
  const previewUrls = stack.previewUrls ?? {};

  const addCandidate = (serviceName: string, url: string | null | undefined) => {
    const trimmedUrl = nonEmpty(url);
    if (!trimmedUrl) return;
    const key = `${serviceName}\u0000${trimmedUrl}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ serviceName, url: trimmedUrl });
  };

  for (const service of stack.services ?? []) {
    addCandidate(service.name, service.previewUrl);
    addCandidate(service.name, previewUrls[service.name]);
  }
  for (const [serviceName, url] of Object.entries(previewUrls)) {
    addCandidate(serviceName, url);
  }
  return candidates;
}

function primaryPreviewForStack(stack: AppDevStack): PreviewCandidate | null {
  const candidates = collectPreviewCandidates(stack);
  for (const serviceName of PRIMARY_PREVIEW_SERVICE_NAMES) {
    const candidate = candidates.find((item) => item.serviceName === serviceName);
    if (candidate) return candidate;
  }
  return candidates[0] ?? null;
}

function previewUrlForService(service: AppDevStackService, stack: AppDevStack): string | null {
  return nonEmpty(service.previewUrl) ?? nonEmpty(stack.previewUrls?.[service.name]) ?? null;
}

function actionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The App Dev Stack action failed.";
}

function StatusBadge({ status }: { readonly status: AppDevStack["status"] }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center rounded-full border px-2 text-[11px] font-medium",
        status === "running" && "border-emerald-500/30 bg-emerald-500/10 text-emerald-600",
        status === "error" && "border-destructive/30 bg-destructive/10 text-destructive",
        status === "stopped" && "border-border bg-muted text-muted-foreground",
        TRANSITIONING_STATUSES.has(status) && "border-amber-500/30 bg-amber-500/10 text-amber-600",
      )}
    >
      {status}
    </span>
  );
}

function EmptyPanelState(props: { readonly title: string; readonly description: string }) {
  return (
    <div className="flex min-h-38 items-center justify-center rounded-lg border border-dashed border-border p-5 text-center">
      <div className="max-w-sm">
        <BoxesIcon className="mx-auto mb-3 size-7 text-muted-foreground" />
        <div className="text-sm font-medium">{props.title}</div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {props.description}
        </div>
      </div>
    </div>
  );
}

function StackServices({ stack }: { readonly stack: AppDevStack }) {
  const services = stack.services ?? [];
  if (services.length === 0) {
    return <div className="text-xs text-muted-foreground">No services reported.</div>;
  }
  return (
    <div className="space-y-1.5">
      {services.map((service) => {
        const previewUrl = previewUrlForService(service, stack);
        return (
          <div
            key={service.name}
            className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-md bg-muted/40 px-2 py-1.5"
          >
            <div className="min-w-0">
              <div className="truncate text-xs font-medium">{service.name}</div>
              <div className="truncate text-[11px] text-muted-foreground">
                {service.status}
                {service.containerPort ? ` · :${service.containerPort}` : ""}
                {service.health ? ` · ${service.health}` : ""}
              </div>
            </div>
            {previewUrl ? (
              <a
                href={previewUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                aria-label={`Open ${service.name}`}
              >
                <ExternalLinkIcon className="size-3.5" />
              </a>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

export function AppDevStackPanel(props: AppDevStackPanelProps) {
  const currentWorktreePath = useMemo(
    () => props.activeThread?.worktreePath ?? props.gitCwd ?? props.workspaceRoot,
    [props.activeThread?.worktreePath, props.gitCwd, props.workspaceRoot],
  );
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [manualPath, setManualPath] = useState(currentWorktreePath);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);

  useEffect(() => {
    setManualPath((current) => (current.trim().length === 0 ? currentWorktreePath : current));
  }, [currentWorktreePath]);

  const statusQuery = useEnvironmentQuery(
    appDevStackEnvironment.status({
      environmentId: props.environmentId,
      input: {},
    }),
  );
  const stackBackendEnabled = statusQuery.data?.enabled === true;
  const currentPath = normalizeWorktreePath(currentWorktreePath);
  const targetPath = normalizeWorktreePath(manualPath);
  const submittedPath = targetPath || currentPath;
  const submittedPathStartKey = submittedPath ? `start:${submittedPath}` : null;
  const startPathChoices = useMemo(() => {
    const choices: StartPathChoice[] = [];
    const seen = new Set<string>();
    const addChoice = (label: string, path: string | null | undefined) => {
      const normalizedPath = normalizeWorktreePath(path ?? "");
      if (!normalizedPath || seen.has(normalizedPath)) return;
      seen.add(normalizedPath);
      choices.push({ label, path: normalizedPath });
    };

    addChoice("Active worktree", props.activeThread?.worktreePath);
    addChoice("Git cwd", props.gitCwd);
    addChoice("Workspace root", props.workspaceRoot);
    return choices;
  }, [props.activeThread?.worktreePath, props.gitCwd, props.workspaceRoot]);
  const browsePath = manualPath.trim();
  const browseQuery = useEnvironmentQuery(
    isCreateOpen && browsePath.length > 0
      ? filesystemEnvironment.browse({
          environmentId: props.environmentId,
          input: {
            partialPath: browsePath,
            cwd: props.workspaceRoot,
          },
        })
      : null,
  );
  const browseEntries = (browseQuery.data?.entries ?? []).slice(0, 8);
  const browseParentPath =
    browsePath.length > 0 ? getBrowseParentPath(ensureBrowseDirectoryPath(browsePath)) : null;
  const currentStackQuery = useEnvironmentQuery(
    stackBackendEnabled && currentPath
      ? appDevStackEnvironment.byWorktree({
          environmentId: props.environmentId,
          input: { worktreePath: currentPath },
        })
      : null,
  );
  const listQuery = useEnvironmentQuery(
    stackBackendEnabled
      ? appDevStackEnvironment.list({
          environmentId: props.environmentId,
          input: {},
        })
      : null,
  );

  const autoCreateStack = useAtomCommand(appDevStackEnvironment.autoCreate, {
    reportFailure: false,
  });
  const stopStack = useAtomCommand(appDevStackEnvironment.stop, { reportFailure: false });
  const deleteStack = useAtomCommand(appDevStackEnvironment.delete, { reportFailure: false });

  const refreshStacks = useCallback(() => {
    statusQuery.refresh();
    currentStackQuery.refresh();
    listQuery.refresh();
  }, [currentStackQuery, listQuery, statusQuery]);

  const stacks = useMemo(() => {
    const currentNormalized = normalizeWorktreePath(currentPath);
    return [...(listQuery.data?.stacks ?? [])].sort((left, right) => {
      const leftCurrent = normalizeWorktreePath(left.worktreePath) === currentNormalized;
      const rightCurrent = normalizeWorktreePath(right.worktreePath) === currentNormalized;
      if (leftCurrent !== rightCurrent) return leftCurrent ? -1 : 1;
      return stackUpdatedTime(right) - stackUpdatedTime(left);
    });
  }, [currentPath, listQuery.data?.stacks]);

  const currentStack =
    currentStackQuery.data?.stack ??
    stacks.find((stack) => normalizeWorktreePath(stack.worktreePath) === currentPath) ??
    null;

  const runStart = useCallback(
    async (worktreePath: string, sourceStack?: AppDevStack | null) => {
      const normalizedPath = normalizeWorktreePath(worktreePath);
      if (!normalizedPath) return;
      const key = `start:${sourceStack?.id ?? normalizedPath}`;
      setPendingKey(key);
      setActionError(null);
      try {
        const result = await autoCreateStack({
          environmentId: props.environmentId,
          input: {
            worktreePath: normalizedPath,
            displayName: sourceStack?.displayName ?? displayNameFromPath(normalizedPath),
            gitBranch: sourceStack?.branchName ?? props.activeThread?.branch ?? null,
          },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setActionError(actionErrorMessage(squashAtomCommandFailure(result)));
          }
          return;
        }
        refreshStacks();
        if (!sourceStack) {
          setIsCreateOpen(false);
        }
      } finally {
        setPendingKey((current) => (current === key ? null : current));
      }
    },
    [autoCreateStack, props.activeThread?.branch, props.environmentId, refreshStacks],
  );

  const runStop = useCallback(
    async (stack: AppDevStack) => {
      const key = `stop:${stack.id}`;
      setPendingKey(key);
      setActionError(null);
      try {
        const result = await stopStack({
          environmentId: props.environmentId,
          input: { stackId: stack.id },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setActionError(actionErrorMessage(squashAtomCommandFailure(result)));
          }
          return;
        }
        refreshStacks();
      } finally {
        setPendingKey((current) => (current === key ? null : current));
      }
    },
    [props.environmentId, refreshStacks, stopStack],
  );

  const runDelete = useCallback(
    async (stack: AppDevStack) => {
      if (
        !window.confirm(
          `Delete App Stack "${displayStackName(stack)}"? This will remove its Kubernetes namespace.`,
        )
      ) {
        return;
      }
      const key = `delete:${stack.id}`;
      setPendingKey(key);
      setActionError(null);
      try {
        const result = await deleteStack({
          environmentId: props.environmentId,
          input: { stackId: stack.id },
        });
        if (result._tag === "Failure") {
          if (!isAtomCommandInterrupted(result)) {
            setActionError(actionErrorMessage(squashAtomCommandFailure(result)));
          }
          return;
        }
        refreshStacks();
      } finally {
        setPendingKey((current) => (current === key ? null : current));
      }
    },
    [deleteStack, props.environmentId, refreshStacks],
  );

  const openPreview = useCallback(
    async (candidate: PreviewCandidate) => {
      if (!isPreviewSupportedInRuntime()) return;
      setActionError(null);
      const result = await openUrlInPreview({
        threadRef: props.threadRef,
        url: candidate.url,
        openPreview: props.openPreview,
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        setActionError(actionErrorMessage(squashAtomCommandFailure(result)));
      }
    },
    [props.openPreview, props.threadRef],
  );

  const runCreateStart = useCallback(() => {
    if (!stackBackendEnabled || !submittedPath || pendingKey !== null) return;
    void runStart(submittedPath, null);
  }, [pendingKey, runStart, stackBackendEnabled, submittedPath]);

  const browseToPath = useCallback((path: string) => {
    setManualPath(ensureBrowseDirectoryPath(path));
  }, []);

  const renderStackRow = (stack: AppDevStack) => {
    const preview = primaryPreviewForStack(stack);
    const isTransitioning = TRANSITIONING_STATUSES.has(stack.status);
    const startKey = `start:${stack.id}`;
    const stopKey = `stop:${stack.id}`;
    const deleteKey = `delete:${stack.id}`;
    const startPending = pendingKey === startKey;
    const stopPending = pendingKey === stopKey;
    const deletePending = pendingKey === deleteKey;
    const repoBranch = stackRepoBranchLabel(stack);

    return (
      <div key={stack.id} className="rounded-lg border border-border bg-card/35 p-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <div className="truncate text-sm font-medium">{displayStackName(stack)}</div>
              <StatusBadge status={stack.status} />
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {repoBranch ? `${repoBranch} · ` : ""}
              {stack.namespace ? `namespace ${stack.namespace}` : "namespace pending"}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {preview ? (
              <>
                {isPreviewSupportedInRuntime() ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => void openPreview(preview)}
                    aria-label={`Open ${preview.serviceName} in the browser panel`}
                  >
                    <ExternalLinkIcon className="size-3.5" />
                  </Button>
                ) : null}
                <Button
                  size="icon-xs"
                  variant="ghost"
                  render={<a href={preview.url} target="_blank" rel="noreferrer" />}
                  aria-label={`Open ${preview.serviceName} externally`}
                >
                  <ExternalLinkIcon className="size-3.5" />
                </Button>
              </>
            ) : null}
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => void runStart(stack.worktreePath, stack)}
              disabled={isTransitioning || pendingKey !== null}
              aria-label="Start stack"
            >
              {startPending ? <LoaderIcon className="size-3.5 animate-spin" /> : <PlayIcon />}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => void runStop(stack)}
              disabled={stack.status === "stopped" || isTransitioning || pendingKey !== null}
              aria-label="Stop stack"
            >
              {stopPending ? <LoaderIcon className="size-3.5 animate-spin" /> : <PowerIcon />}
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => void runDelete(stack)}
              disabled={isTransitioning || pendingKey !== null}
              aria-label="Delete stack"
            >
              {deletePending ? <LoaderIcon className="size-3.5 animate-spin" /> : <Trash2Icon />}
            </Button>
          </div>
        </div>
        <div className="mt-2 truncate text-xs text-muted-foreground">{stack.worktreePath}</div>
        {stack.lastError ? (
          <div className="mt-2 rounded-md border border-destructive/20 bg-destructive/5 p-2 text-xs text-destructive">
            {stack.lastError}
          </div>
        ) : null}
        <div className="mt-3">
          <StackServices stack={stack} />
        </div>
      </div>
    );
  };

  if (statusQuery.isPending && !statusQuery.data) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-muted-foreground">
        <LoaderIcon className="mr-2 size-4 animate-spin" />
        Loading App Stack
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium">
              <BoxesIcon className="size-4 text-muted-foreground" />
              App Stack
            </div>
            <div className="mt-1 truncate text-xs text-muted-foreground">
              {props.activeProject.title}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => setIsCreateOpen((open) => !open)}
              data-pressed={isCreateOpen ? "" : undefined}
              aria-label="Start app stack from path"
            >
              <PlusIcon className="size-3.5" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={refreshStacks}
              disabled={statusQuery.isPending || listQuery.isPending || currentStackQuery.isPending}
              aria-label="Refresh app stacks"
            >
              <RefreshCwIcon
                className={cn(
                  "size-3.5",
                  (statusQuery.isPending || listQuery.isPending || currentStackQuery.isPending) &&
                    "animate-spin",
                )}
              />
            </Button>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-4">
          {statusQuery.error ? (
            <div className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <div>{statusQuery.error}</div>
            </div>
          ) : null}

          {isCreateOpen ? (
            <section className="space-y-3 rounded-lg border border-border bg-card/35 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-sm font-medium">New Stack</div>
                  <div className="mt-1 truncate text-xs text-muted-foreground">
                    {props.activeProject.title}
                  </div>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => setIsCreateOpen(false)}
                  aria-label="Close new stack"
                >
                  <XIcon className="size-3.5" />
                </Button>
              </div>

              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  runCreateStart();
                }}
              >
                <Input
                  value={manualPath}
                  onChange={(event) => setManualPath(event.currentTarget.value)}
                  placeholder={currentPath}
                  className="min-w-0 flex-1"
                />
                <Button
                  size="sm"
                  type="submit"
                  disabled={!stackBackendEnabled || !submittedPath || pendingKey !== null}
                >
                  {pendingKey === submittedPathStartKey ? (
                    <LoaderIcon className="animate-spin" />
                  ) : (
                    <PlayIcon />
                  )}
                  Start
                </Button>
              </form>

              {!stackBackendEnabled ? (
                <div className="flex gap-2 rounded-md border border-amber-500/25 bg-amber-500/5 p-2 text-xs text-amber-700 dark:text-amber-500">
                  <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                  <div>
                    Set T3CODE_APP_DEV_STACK_BACKEND_URL on the server before starting stacks.
                  </div>
                </div>
              ) : null}

              {startPathChoices.length > 0 ? (
                <div className="space-y-1">
                  {startPathChoices.map((choice) => (
                    <button
                      key={choice.path}
                      type="button"
                      className={cn(
                        "grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent",
                        normalizeWorktreePath(manualPath) === choice.path && "bg-accent/70",
                      )}
                      onClick={() => setManualPath(choice.path)}
                    >
                      <FolderIcon className="size-3.5 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="block font-medium">{choice.label}</span>
                        <span className="block truncate text-muted-foreground">{choice.path}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}

              {browsePath.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-border/70">
                  {browseParentPath ? (
                    <button
                      type="button"
                      className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-b border-border/70 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                      onClick={() => setManualPath(browseParentPath)}
                    >
                      <CornerLeftUpIcon className="size-3.5 text-muted-foreground" />
                      <span className="truncate">..</span>
                    </button>
                  ) : null}
                  {browseQuery.error ? (
                    <div className="px-2 py-2 text-xs text-destructive">{browseQuery.error}</div>
                  ) : browseQuery.isPending ? (
                    <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                      <LoaderIcon className="size-3.5 animate-spin" />
                      Loading directories
                    </div>
                  ) : browseEntries.length > 0 ? (
                    browseEntries.map((entry) => (
                      <button
                        key={entry.fullPath}
                        type="button"
                        className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-t border-border/50 px-2 py-1.5 text-left text-xs transition-colors first:border-t-0 hover:bg-accent"
                        onClick={() => browseToPath(entry.fullPath)}
                      >
                        <FolderIcon className="size-3.5 text-muted-foreground" />
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{entry.name}</span>
                          <span className="block truncate text-muted-foreground">
                            {entry.fullPath}
                          </span>
                        </span>
                      </button>
                    ))
                  ) : (
                    <div className="px-2 py-2 text-xs text-muted-foreground">
                      No matching directories
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          {actionError ? (
            <div className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
              <TriangleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <div>{actionError}</div>
            </div>
          ) : null}

          {!stackBackendEnabled ? (
            <EmptyPanelState
              title="Stack backend is not configured"
              description="Set T3CODE_APP_DEV_STACK_BACKEND_URL on the server to the Cortex API base URL that serves /api/app-dev-stacks."
            />
          ) : (
            <>
              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Current Worktree
                  </div>
                  {currentStackQuery.isPending ? (
                    <LoaderIcon className="size-3.5 animate-spin text-muted-foreground" />
                  ) : null}
                </div>
                {currentStack ? (
                  renderStackRow(currentStack)
                ) : (
                  <EmptyPanelState
                    title="No stack for this worktree"
                    description="Start a stack to create an isolated Kubernetes namespace for the current branch or worktree."
                  />
                )}
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    All Stacks
                  </div>
                  <div className="text-xs text-muted-foreground">{stacks.length}</div>
                </div>
                {listQuery.error ? (
                  <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
                    {listQuery.error}
                  </div>
                ) : stacks.length > 0 ? (
                  <div className="space-y-2">{stacks.map(renderStackRow)}</div>
                ) : (
                  <EmptyPanelState
                    title="No app stacks"
                    description="Start stacks from one or more worktrees to run them in parallel namespaces."
                  />
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
