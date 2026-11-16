import type {
  StackLogTailSelection,
  StackPodLogServiceGroup,
} from "@t3tools/client-runtime/app-stack-logs";
import type { AppStack, AppStackPodLogEntry, AppStackStatus } from "@t3tools/contracts";

export type AppStackTone = "running" | "transitioning" | "error" | "stopped";

export const APP_STACK_TONE_DOT_CLASS = {
  running: "bg-adaptive-emerald-600-400",
  transitioning: "bg-adaptive-sky-600-400",
  error: "bg-adaptive-rose-600-400",
  stopped: "bg-foreground-muted",
} as const satisfies Record<AppStackTone, string>;

export const APP_STACK_TONE_TEXT_CLASS = {
  running: "text-adaptive-emerald-600-400",
  transitioning: "text-adaptive-sky-600-400",
  error: "text-adaptive-rose-600-400",
  stopped: "text-foreground-muted",
} as const satisfies Record<AppStackTone, string>;

/**
 * Mobile offers the bounded tails only. "All" reads every stack's logs in the
 * environment and filters on the client, which is too much data for a phone.
 */
export const APP_STACK_LOG_TAIL_OPTIONS = [100, 300, 1000, 5000] as const satisfies ReadonlyArray<
  Exclude<StackLogTailSelection, "all">
>;

export function appStackTone(status: AppStackStatus): AppStackTone {
  if (status === "running") return "running";
  if (status === "error") return "error";
  if (status === "stopped") return "stopped";
  return "transitioning";
}

export function appStackStatusLabel(status: AppStackStatus): string {
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

/**
 * The lifecycle rows a stack offers. A stopped bundle starts again through
 * restart, because a plain start would drop the other apps and the services
 * it left out (the web panel makes the same choice).
 */
export function appStackLifecycle(stack: AppStack): {
  readonly start: "create" | "restart" | null;
  readonly canStop: boolean;
} {
  const idle = stack.status === "stopped" || stack.status === "error";
  return {
    start: idle ? (stack.bundleId != null ? "restart" : "create") : null,
    canStop: stack.status !== "stopped" && stack.status !== "stopping",
  };
}

/**
 * The thread chip appears for a stack that is doing something worth glancing
 * at. A stopped stack stays reachable from the Git sheet without occupying
 * the composer overlay on every visit.
 */
export function showThreadAppStackChip(stack: AppStack | null | undefined): boolean {
  return stack != null && stack.status !== "stopped";
}

export type AppStackLogListItem =
  | {
      readonly kind: "service";
      readonly key: string;
      readonly group: StackPodLogServiceGroup;
      readonly collapsed: boolean;
    }
  | { readonly kind: "entry"; readonly key: string; readonly entry: AppStackPodLogEntry };

/**
 * Flattens service groups into one virtualized list: a header per service,
 * then a block per container unless the service is collapsed.
 */
export function appStackLogListItems(
  groups: ReadonlyArray<StackPodLogServiceGroup>,
  collapsed: ReadonlySet<string>,
): AppStackLogListItem[] {
  return groups.flatMap((group): AppStackLogListItem[] => {
    const isCollapsed = collapsed.has(group.serviceKey);
    const header: AppStackLogListItem = {
      kind: "service",
      key: `service:${group.serviceKey}`,
      group,
      collapsed: isCollapsed,
    };
    if (isCollapsed) return [header];
    return [
      header,
      ...group.pods.flatMap((pod) =>
        pod.entries.map((entry): AppStackLogListItem => ({
          kind: "entry",
          key: `entry:${group.serviceKey}:${pod.podName}:${entry.containerName}`,
          entry,
        })),
      ),
    ];
  });
}
