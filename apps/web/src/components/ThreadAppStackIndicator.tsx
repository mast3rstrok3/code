import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { LayersIcon } from "lucide-react";
import { useEffect } from "react";

import { appStackEnvironment } from "~/state/appStacks";
import { useEnvironmentQuery } from "~/state/query";
import { useRightPanelStore } from "~/rightPanelStore";
import { Button } from "./ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "./ui/tooltip";

export function ThreadAppStackIndicator(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  worktreePath: string;
}) {
  const status = useEnvironmentQuery(
    appStackEnvironment.status({ environmentId: props.environmentId, input: {} }),
  );
  const lookup = useEnvironmentQuery(
    status.data?.enabled
      ? appStackEnvironment.byWorktree({
          environmentId: props.environmentId,
          input: { worktreePath: props.worktreePath },
        })
      : null,
  );
  const refreshStatus = status.refresh;
  const refreshStack = lookup.refresh;
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== "visible") return;
      refreshStatus();
      refreshStack();
    };
    const interval = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshStatus, refreshStack]);

  if (status.data?.enabled === false && !status.error) return null;
  const stack = lookup.data?.stack;
  const error = status.error ?? lookup.error;
  const label = error ? "unavailable" : !lookup.data ? "checking" : (stack?.status ?? "none");
  const title = [
    `App Stack: ${label} · Dev`,
    props.worktreePath,
    ...(stack ? [stack.displayName ?? stack.id, stack.namespace, lookup.data?.frontendUrl] : []),
    error,
    "Open App Stack",
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="xs"
            className="h-7 min-w-0 shrink px-1.5 text-xs font-normal text-muted-foreground sm:h-6"
            data-composer-context-control
            aria-label={`App Stack: ${label} · Dev. Open App Stack`}
            onClick={() =>
              useRightPanelStore
                .getState()
                .open(scopeThreadRef(props.environmentId, props.threadId), "app-stack")
            }
          />
        }
      >
        <LayersIcon className="size-3 shrink-0" />
        <span className="max-w-40 truncate">App Stack: {label} · Dev</span>
      </TooltipTrigger>
      <TooltipPopup>
        <span className="whitespace-pre-line">{title}</span>
      </TooltipPopup>
    </Tooltip>
  );
}
