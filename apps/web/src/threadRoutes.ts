import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
  WorkflowId,
} from "@t3tools/contracts";
import type { DraftId } from "./composerDraftStore";

export type ThreadRouteTarget =
  | {
      kind: "server";
      threadRef: ScopedThreadRef;
    }
  | {
      kind: "draft";
      draftId: DraftId;
    };

type DraftThreadRouteState = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  promotedTo?: ScopedThreadRef | null;
};

export type ThreadRouteRenderState = "loading" | "ready" | "missing";

export type ThreadRouteSearch = {
  readonly workflow?: WorkflowId;
};

export function resolveThreadRouteSearch(search: Record<string, unknown>): ThreadRouteSearch {
  const workflow = typeof search.workflow === "string" ? search.workflow.trim() : "";
  return workflow.length > 0 ? { workflow: WorkflowId.make(workflow) } : {};
}

export function buildWorkflowRouteUrl(input: {
  readonly currentHref: string;
  readonly environmentId: EnvironmentId;
  readonly rootThreadId: ThreadId;
  readonly workflowId: WorkflowId;
}): string {
  const url = new URL(input.currentHref);
  url.pathname = `/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.rootThreadId)}`;
  url.search = "";
  url.searchParams.set("workflow", input.workflowId);
  url.hash = "";
  return url.toString();
}

export function resolveThreadRouteRenderState(input: {
  bootstrapComplete: boolean;
  serverThreadShellExists: boolean;
  serverThreadDetailExists: boolean;
  serverThreadDetailDeleted: boolean;
  draftThreadExists: boolean;
}): ThreadRouteRenderState {
  if (!input.bootstrapComplete) {
    return "loading";
  }
  if (input.serverThreadDetailExists || input.draftThreadExists) {
    return "ready";
  }
  if (input.serverThreadDetailDeleted) {
    return "missing";
  }
  return input.serverThreadShellExists ? "loading" : "missing";
}

export function buildThreadRouteParams(ref: ScopedThreadRef): {
  environmentId: EnvironmentId;
  threadId: ThreadId;
} {
  return {
    environmentId: ref.environmentId,
    threadId: ref.threadId,
  };
}

export function buildDraftThreadRouteParams(draftId: DraftId): {
  draftId: DraftId;
} {
  return { draftId };
}

export function resolveThreadRouteRef(
  params: Partial<Record<"environmentId" | "threadId", string | undefined>>,
): ScopedThreadRef | null {
  if (!params.environmentId || !params.threadId) {
    return null;
  }

  return scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId);
}

export function resolveThreadRouteTarget(
  params: Partial<Record<"environmentId" | "threadId" | "draftId", string | undefined>>,
): ThreadRouteTarget | null {
  if (params.environmentId && params.threadId) {
    return {
      kind: "server",
      threadRef: scopeThreadRef(params.environmentId as EnvironmentId, params.threadId as ThreadId),
    };
  }

  if (!params.draftId) {
    return null;
  }

  return {
    kind: "draft",
    draftId: params.draftId as DraftId,
  };
}

/**
 * Resolves the thread represented by either a canonical thread route or a
 * draft route whose promotion to a server thread has been recorded.
 */
export function resolveActiveThreadRouteRef(
  target: ThreadRouteTarget | null,
  draftThread: DraftThreadRouteState | null,
): ScopedThreadRef | null {
  if (target?.kind === "server") {
    return target.threadRef;
  }
  if (target?.kind !== "draft" || !draftThread?.promotedTo) {
    return null;
  }
  return draftThread.promotedTo;
}
