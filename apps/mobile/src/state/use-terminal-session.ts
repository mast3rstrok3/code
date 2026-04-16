import { useAtomValue } from "@effect/atom-react";
import {
  createTerminalSessionManager,
  EMPTY_TERMINAL_SESSION_ATOM,
  EMPTY_TERMINAL_SESSION_STATE,
  getTerminalSessionTargetKey,
  knownTerminalSessionsAtom,
  terminalSessionStateAtom,
  type TerminalSessionState,
} from "@t3tools/client-runtime";
import { useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";

export const terminalSessionManager = createTerminalSessionManager({
  getRegistry: () => appAtomRegistry,
});

export function useTerminalSession(input: {
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly terminalId: string | null;
}): TerminalSessionState {
  const targetKey = getTerminalSessionTargetKey(input);
  const state = useAtomValue(
    targetKey !== null ? terminalSessionStateAtom(targetKey) : EMPTY_TERMINAL_SESSION_ATOM,
  );
  return targetKey === null ? EMPTY_TERMINAL_SESSION_STATE : state;
}

export function useTerminalSessionTarget(input: {
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly terminalId: string | null;
}) {
  return useMemo(
    () => ({
      environmentId: input.environmentId,
      threadId: input.threadId,
      terminalId: input.terminalId,
    }),
    [input.environmentId, input.threadId, input.terminalId],
  );
}

export function useKnownTerminalSessions(input: {
  readonly environmentId: string | null;
  readonly threadId: string | null;
}) {
  const knownSessionsIndex = useAtomValue(knownTerminalSessionsAtom);

  return useMemo(() => {
    if (input.environmentId === null || input.threadId === null) {
      return [];
    }

    void knownSessionsIndex;
    return terminalSessionManager.listSessions({
      environmentId: input.environmentId,
      threadId: input.threadId,
    });
  }, [input.environmentId, input.threadId, knownSessionsIndex]);
}
