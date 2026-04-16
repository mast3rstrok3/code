import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export interface TerminalSessionState {
  readonly snapshot: TerminalSessionSnapshot | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalSessionTarget {
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly terminalId: string | null;
}

export interface KnownTerminalSessionTarget {
  readonly environmentId: string;
  readonly threadId: string;
  readonly terminalId: string;
}

export interface KnownTerminalSession {
  readonly target: KnownTerminalSessionTarget;
  readonly state: TerminalSessionState;
}

export interface TerminalSessionManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly maxBufferBytes?: number;
}

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  snapshot: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
});

const DEFAULT_MAX_BUFFER_BYTES = 512 * 1024;
const knownTerminalSessionKeys = new Set<string>();
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const terminalSessionStateAtom = Atom.family((key: string) => {
  knownTerminalSessionKeys.add(key);
  return Atom.make(EMPTY_TERMINAL_SESSION_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`terminal-session:${key}`),
  );
});

export const EMPTY_TERMINAL_SESSION_ATOM = Atom.make(EMPTY_TERMINAL_SESSION_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("terminal-session:null"),
);

export const knownTerminalSessionsAtom = Atom.make<Record<string, KnownTerminalSessionTarget>>(
  {},
).pipe(Atom.keepAlive, Atom.withLabel("terminal-session:index"));

export function getTerminalSessionTargetKey(target: TerminalSessionTarget): string | null {
  if (target.environmentId === null || target.threadId === null || target.terminalId === null) {
    return null;
  }

  return `${target.environmentId}:${target.threadId}:${target.terminalId}`;
}

function toKnownTarget(target: TerminalSessionTarget): KnownTerminalSessionTarget | null {
  const targetKey = getTerminalSessionTargetKey(target);
  if (targetKey === null) {
    return null;
  }

  const environmentId = target.environmentId;
  const threadId = target.threadId;
  const terminalId = target.terminalId;
  if (environmentId === null || threadId === null || terminalId === null) {
    return null;
  }

  return {
    environmentId,
    threadId,
    terminalId,
  };
}

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (maxBufferBytes <= 0) {
    return "";
  }

  const encoded = textEncoder.encode(buffer);
  if (encoded.byteLength <= maxBufferBytes) {
    return buffer;
  }

  let start = encoded.byteLength - maxBufferBytes;
  while (start < encoded.length) {
    const byte = encoded[start];
    if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
      break;
    }
    start += 1;
  }

  return textDecoder.decode(encoded.subarray(start));
}

function stateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalSessionState {
  return {
    snapshot,
    buffer: trimBufferToBytes(snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    hasRunningSubprocess: false,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

export function createTerminalSessionManager(config: TerminalSessionManagerConfig) {
  const maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const closedSessionStates = new Map<string, TerminalSessionState>();

  function clearKnownSessionAtomState(targetKey: string): void {
    knownTerminalSessionKeys.delete(targetKey);
    config.getRegistry().set(terminalSessionStateAtom(targetKey), EMPTY_TERMINAL_SESSION_STATE);
  }

  function rememberTarget(target: TerminalSessionTarget): string | null {
    const targetKey = getTerminalSessionTargetKey(target);
    const knownTarget = toKnownTarget(target);
    if (targetKey === null || knownTarget === null) {
      return null;
    }

    closedSessionStates.delete(targetKey);

    const current = config.getRegistry().get(knownTerminalSessionsAtom);
    const existing = current[targetKey];
    if (
      existing?.environmentId === knownTarget.environmentId &&
      existing.threadId === knownTarget.threadId &&
      existing.terminalId === knownTarget.terminalId
    ) {
      return targetKey;
    }

    config.getRegistry().set(knownTerminalSessionsAtom, {
      ...current,
      [targetKey]: knownTarget,
    });
    return targetKey;
  }

  function removeTargets(
    match: (target: KnownTerminalSessionTarget) => boolean,
  ): ReadonlyArray<string> {
    const current = config.getRegistry().get(knownTerminalSessionsAtom);
    const removedKeys: string[] = [];
    const next = Object.fromEntries(
      Object.entries(current).filter(([key, target]) => {
        const shouldRemove = match(target);
        if (shouldRemove) {
          removedKeys.push(key);
        }
        return !shouldRemove;
      }),
    ) as Record<string, KnownTerminalSessionTarget>;
    if (Object.keys(next).length === Object.keys(current).length) {
      return removedKeys;
    }

    config.getRegistry().set(knownTerminalSessionsAtom, next);
    return removedKeys;
  }

  function getSnapshot(target: TerminalSessionTarget): TerminalSessionState {
    const targetKey = getTerminalSessionTargetKey(target);
    if (targetKey === null) {
      return EMPTY_TERMINAL_SESSION_STATE;
    }

    const closedState = closedSessionStates.get(targetKey);
    if (closedState) {
      return closedState;
    }

    const rememberedTargetKey = rememberTarget(target);
    if (rememberedTargetKey === null) {
      return EMPTY_TERMINAL_SESSION_STATE;
    }

    return config.getRegistry().get(terminalSessionStateAtom(rememberedTargetKey));
  }

  function setState(targetKey: string, nextState: TerminalSessionState): void {
    config.getRegistry().set(terminalSessionStateAtom(targetKey), nextState);
  }

  function syncSnapshot(
    target: Pick<TerminalSessionTarget, "environmentId">,
    snapshot: TerminalSessionSnapshot,
  ): void {
    const targetKey = rememberTarget({
      environmentId: target.environmentId,
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
    });
    if (targetKey === null) {
      return;
    }

    setState(targetKey, stateFromSnapshot(snapshot, maxBufferBytes));
  }

  function applyEvent(
    target: Pick<TerminalSessionTarget, "environmentId">,
    event: TerminalEvent,
  ): void {
    const targetKey = rememberTarget({
      environmentId: target.environmentId,
      threadId: event.threadId,
      terminalId: event.terminalId,
    });
    if (targetKey === null) {
      return;
    }

    const current = config.getRegistry().get(terminalSessionStateAtom(targetKey));
    switch (event.type) {
      case "started":
      case "restarted":
        setState(targetKey, stateFromSnapshot(event.snapshot, maxBufferBytes));
        return;
      case "output":
        setState(targetKey, {
          ...current,
          buffer: trimBufferToBytes(`${current.buffer}${event.data}`, maxBufferBytes),
          status: current.status === "closed" ? "running" : current.status,
          error: null,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
      case "cleared":
        setState(targetKey, {
          ...current,
          buffer: "",
          error: null,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
      case "exited":
        setState(targetKey, {
          ...current,
          snapshot: current.snapshot
            ? {
                ...current.snapshot,
                status: "exited",
                exitCode: event.exitCode,
                exitSignal: event.exitSignal,
                updatedAt: event.createdAt,
              }
            : null,
          status: "exited",
          hasRunningSubprocess: false,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
      case "closed":
        closedSessionStates.set(targetKey, {
          ...current,
          snapshot: null,
          status: "closed",
          error: null,
          hasRunningSubprocess: false,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        clearKnownSessionAtomState(targetKey);
        removeTargets(
          (knownTarget) =>
            knownTarget.environmentId === target.environmentId &&
            knownTarget.threadId === event.threadId &&
            knownTarget.terminalId === event.terminalId,
        );
        return;
      case "error":
        setState(targetKey, {
          ...current,
          status: "error",
          error: event.message,
          hasRunningSubprocess: false,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
      case "activity":
        setState(targetKey, {
          ...current,
          hasRunningSubprocess: event.hasRunningSubprocess,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
    }
  }

  function invalidate(target?: TerminalSessionTarget): void {
    if (target) {
      const targetKey = getTerminalSessionTargetKey(target);
      if (targetKey !== null) {
        closedSessionStates.delete(targetKey);
        setState(targetKey, EMPTY_TERMINAL_SESSION_STATE);
      }
      return;
    }

    for (const key of knownTerminalSessionKeys) {
      setState(key, EMPTY_TERMINAL_SESSION_STATE);
    }
    closedSessionStates.clear();
    knownTerminalSessionKeys.clear();
    config.getRegistry().set(knownTerminalSessionsAtom, {});
  }

  function invalidateEnvironment(environmentId: string): void {
    const prefix = `${environmentId}:`;
    for (const key of knownTerminalSessionKeys) {
      if (key.startsWith(prefix)) {
        setState(key, EMPTY_TERMINAL_SESSION_STATE);
      }
    }
    for (const key of closedSessionStates.keys()) {
      if (key.startsWith(prefix)) {
        closedSessionStates.delete(key);
      }
    }
    for (const key of removeTargets((target) => target.environmentId === environmentId)) {
      closedSessionStates.delete(key);
      clearKnownSessionAtomState(key);
    }
  }

  function reset(): void {
    invalidate();
  }

  function listSessions(
    filter?: Partial<KnownTerminalSessionTarget>,
  ): ReadonlyArray<KnownTerminalSession> {
    const knownTargets = Object.values(config.getRegistry().get(knownTerminalSessionsAtom));
    return knownTargets
      .filter((target) => {
        if (filter?.environmentId && target.environmentId !== filter.environmentId) {
          return false;
        }
        if (filter?.threadId && target.threadId !== filter.threadId) {
          return false;
        }
        if (filter?.terminalId && target.terminalId !== filter.terminalId) {
          return false;
        }
        return true;
      })
      .map((target) => ({
        target,
        state: getSnapshot(target),
      }))
      .sort((left, right) => {
        const leftUpdatedAt = left.state.updatedAt ? Date.parse(left.state.updatedAt) : 0;
        const rightUpdatedAt = right.state.updatedAt ? Date.parse(right.state.updatedAt) : 0;
        if (leftUpdatedAt !== rightUpdatedAt) {
          return rightUpdatedAt - leftUpdatedAt;
        }
        return left.target.terminalId.localeCompare(right.target.terminalId);
      });
  }

  return {
    applyEvent,
    getSnapshot,
    invalidate,
    invalidateEnvironment,
    listSessions,
    syncSnapshot,
    reset,
  };
}
