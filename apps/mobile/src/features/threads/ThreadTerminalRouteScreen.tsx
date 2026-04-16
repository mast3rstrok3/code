import { DEFAULT_TERMINAL_ID } from "@t3tools/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text as RNText, View } from "react-native";
import { KeyboardStickyView } from "react-native-keyboard-controller";
import Animated, { useAnimatedKeyboard, useAnimatedStyle } from "react-native-reanimated";

import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { buildThreadTerminalRoutePath } from "../../lib/routes";
import {
  getEnvironmentClient,
  useRemoteEnvironmentState,
} from "../../state/use-remote-environment-registry";
import {
  terminalSessionManager,
  useKnownTerminalSessions,
  useTerminalSession,
  useTerminalSessionTarget,
} from "../../state/use-terminal-session";
import { useThreadSelection } from "../../state/use-thread-selection";
import { useSelectedThreadDetail } from "../../state/use-thread-detail";
import { TerminalSurface } from "../../native/terminal/NativeTerminalSurface";
import { loadPreferences, savePreferencesPatch } from "../../lib/storage";
import { resolveTerminalRouteBootstrap } from "./terminalRouteBootstrap";
import { resolveTerminalOpenLocation } from "./terminalLaunchContext";
import {
  basename,
  buildTerminalMenuSessions,
  getTerminalLabel,
  getTerminalStatusLabel,
  nextTerminalId,
} from "./terminalMenu";
import {
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STEP,
  normalizeTerminalFontSize,
} from "./terminalPreferences";

const DEFAULT_TERMINAL_COLS = 80;
const DEFAULT_TERMINAL_ROWS = 24;
const TERMINAL_ACCESSORY_HEIGHT = 52;

type PendingModifier = "ctrl" | "meta";
type HostPlatform = "mac" | "linux" | "windows" | "unknown";

type TerminalToolbarAction =
  | { readonly kind: "send"; readonly key: string; readonly label: string; readonly data: string }
  | {
      readonly kind: "modifier";
      readonly key: string;
      readonly label: string;
      readonly modifier: PendingModifier;
    };

interface TerminalMenuSession {
  readonly terminalId: string;
  readonly cwd: string | null;
  readonly status: "starting" | "running" | "exited" | "error" | "closed";
  readonly updatedAt: string | null;
}

function getTerminalStatusTone(input: {
  readonly status: TerminalMenuSession["status"];
  readonly hasRunningSubprocess?: boolean;
}): {
  readonly tintColor: string;
  readonly textColor: string;
} {
  if (input.status === "running") {
    if (input.hasRunningSubprocess) {
      return {
        tintColor: "#fbbf24",
        textColor: "#a3a3a3",
      };
    }

    return {
      tintColor: "#34d399",
      textColor: "#a3a3a3",
    };
  }

  if (input.status === "starting") {
    return {
      tintColor: "#f59e0b",
      textColor: "#a3a3a3",
    };
  }

  if (input.status === "error") {
    return {
      tintColor: "#ef4444",
      textColor: "#fca5a5",
    };
  }

  return {
    tintColor: "#ef4444",
    textColor: "#a3a3a3",
  };
}

function firstRouteParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function inferHostPlatform(environmentLabel: string | null): HostPlatform {
  const value = environmentLabel?.toLowerCase() ?? "";
  if (
    value.includes("mac") ||
    value.includes("macbook") ||
    value.includes("mac mini") ||
    value.includes("imac") ||
    value.includes("darwin")
  ) {
    return "mac";
  }
  if (value.includes("windows") || value.includes("win")) {
    return "windows";
  }
  if (value.includes("linux") || value.includes("ubuntu") || value.includes("debian")) {
    return "linux";
  }

  return "unknown";
}

function applyCtrlModifier(input: string): string {
  const firstCharacter = input[0];
  if (!firstCharacter) {
    return input;
  }

  const lowerCharacter = firstCharacter.toLowerCase();
  if (lowerCharacter >= "a" && lowerCharacter <= "z") {
    return String.fromCharCode(lowerCharacter.charCodeAt(0) - 96);
  }

  if (firstCharacter === "@") return "\u0000";
  if (firstCharacter === "[") return "\u001b";
  if (firstCharacter === "\\") return "\u001c";
  if (firstCharacter === "]") return "\u001d";
  if (firstCharacter === "^") return "\u001e";
  if (firstCharacter === "_") return "\u001f";
  if (firstCharacter === "?") return "\u007f";

  return input;
}

export function ThreadTerminalRouteScreen() {
  const router = useRouter();
  const keyboard = useAnimatedKeyboard();
  const { isLoadingSavedConnection } = useRemoteEnvironmentState();
  const params = useLocalSearchParams<{
    environmentId?: string | string[];
    threadId?: string | string[];
    terminalId?: string | string[];
  }>();
  const { selectedThread, selectedThreadProject, selectedEnvironmentConnection } =
    useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const requestedTerminalId = firstRouteParam(params.terminalId);
  const knownSessions = useKnownTerminalSessions({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
  });
  const [lastGridSize, setLastGridSize] = useState({
    cols: DEFAULT_TERMINAL_COLS,
    rows: DEFAULT_TERMINAL_ROWS,
  });
  const [pendingModifier, setPendingModifier] = useState<PendingModifier | null>(null);
  const [fontSize, setFontSize] = useState(DEFAULT_TERMINAL_FONT_SIZE);
  const hasOpenedRef = useRef(false);
  const hasLoadedFontPreferenceRef = useRef(false);

  const terminalId = requestedTerminalId ?? DEFAULT_TERMINAL_ID;
  const target = useTerminalSessionTarget({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
    terminalId,
  });
  const terminal = useTerminalSession(target);
  const terminalKey = useMemo(
    () =>
      selectedThread
        ? `${selectedThread.environmentId}:${selectedThread.id}:${terminalId}`
        : terminalId,
    [selectedThread, terminalId],
  );
  const isRunning = terminal.status === "running" || terminal.status === "starting";
  const cwd = terminal.snapshot?.cwd ?? selectedThreadProject?.workspaceRoot ?? null;
  const hostPlatform = useMemo(
    () => inferHostPlatform(selectedEnvironmentConnection?.environmentLabel ?? null),
    [selectedEnvironmentConnection?.environmentLabel],
  );
  const runningSession = useMemo(
    () =>
      knownSessions.find(
        (session) => session.state.status === "running" || session.state.status === "starting",
      ) ?? null,
    [knownSessions],
  );
  const activeKnownSession = useMemo(
    () => knownSessions.find((session) => session.target.terminalId === terminalId) ?? null,
    [knownSessions, terminalId],
  );
  const terminalStatusTone = useMemo(
    () =>
      getTerminalStatusTone({
        status: terminal.status,
        hasRunningSubprocess: terminal.hasRunningSubprocess,
      }),
    [terminal.hasRunningSubprocess, terminal.status],
  );
  const headerTitle = useMemo(() => {
    const topLineParts = [
      selectedEnvironmentConnection?.environmentLabel ?? null,
      selectedThreadProject?.title ?? null,
    ].filter((value): value is string => Boolean(value));

    return {
      topLine: topLineParts.join(" \u00b7 "),
      bottomLine: cwd ?? selectedThreadProject?.workspaceRoot ?? "",
    };
  }, [
    cwd,
    selectedEnvironmentConnection?.environmentLabel,
    selectedThreadProject?.title,
    selectedThreadProject?.workspaceRoot,
  ]);
  const terminalToolbarActions = useMemo<ReadonlyArray<TerminalToolbarAction>>(() => {
    const modifierActions: ReadonlyArray<TerminalToolbarAction> =
      hostPlatform === "mac"
        ? [
            { kind: "modifier", key: "cmd", label: "cmd", modifier: "meta" },
            { kind: "modifier", key: "ctrl", label: "ctrl", modifier: "ctrl" },
          ]
        : [
            { kind: "modifier", key: "ctrl", label: "ctrl", modifier: "ctrl" },
            { kind: "modifier", key: "alt", label: "alt", modifier: "meta" },
          ];

    return [
      { kind: "send", key: "esc", label: "esc", data: "\u001b" },
      ...modifierActions,
      { kind: "send", key: "tab", label: "tab", data: "\t" },
      { kind: "send", key: "up", label: "↑", data: "\u001b[A" },
      { kind: "send", key: "down", label: "↓", data: "\u001b[B" },
      { kind: "send", key: "left", label: "←", data: "\u001b[D" },
      { kind: "send", key: "right", label: "→", data: "\u001b[C" },
      { kind: "send", key: "tilde", label: "~", data: "~" },
      { kind: "send", key: "pipe", label: "|", data: "|" },
      { kind: "send", key: "slash", label: "/", data: "/" },
      { kind: "send", key: "dash", label: "-", data: "-" },
    ];
  }, [hostPlatform]);
  const terminalBottomInset = TERMINAL_ACCESSORY_HEIGHT;
  const terminalContainerAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom:
      keyboard.height.value > 0
        ? keyboard.height.value + TERMINAL_ACCESSORY_HEIGHT
        : terminalBottomInset,
  }));

  const terminalMenuSessions = useMemo<ReadonlyArray<TerminalMenuSession>>(
    () =>
      buildTerminalMenuSessions({
        knownSessions,
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
        currentSession: {
          terminalId,
          cwd: cwd ?? null,
          status: terminal.status,
          updatedAt: terminal.updatedAt,
        },
      }),
    [
      cwd,
      knownSessions,
      selectedThreadProject?.workspaceRoot,
      terminal.status,
      terminal.updatedAt,
      terminalId,
    ],
  );

  const openTerminal = useCallback(async () => {
    if (!selectedThread || !selectedThreadProject?.workspaceRoot) {
      return;
    }

    const client = getEnvironmentClient(selectedThread.environmentId);
    if (!client) {
      return;
    }

    const launchLocation = resolveTerminalOpenLocation({
      terminalSnapshot: terminal.snapshot,
      activeSessionSnapshot: activeKnownSession?.state.snapshot ?? null,
      workspaceRoot: selectedThreadProject.workspaceRoot,
      threadShellWorktreePath: selectedThread.worktreePath ?? null,
      threadDetailWorktreePath: selectedThreadDetail?.worktreePath ?? null,
    });

    const snapshot = await client.terminal.open({
      threadId: selectedThread.id,
      terminalId,
      cwd: launchLocation.cwd,
      worktreePath: launchLocation.worktreePath,
      cols: lastGridSize.cols,
      rows: lastGridSize.rows,
    });

    terminalSessionManager.syncSnapshot({ environmentId: selectedThread.environmentId }, snapshot);
  }, [
    lastGridSize.cols,
    lastGridSize.rows,
    activeKnownSession?.state.snapshot,
    selectedThreadDetail?.worktreePath,
    selectedThread,
    selectedThreadProject?.workspaceRoot,
    terminal.snapshot,
    terminalId,
  ]);

  useEffect(() => {
    hasOpenedRef.current = false;
  }, [terminalKey]);

  useEffect(() => {
    let cancelled = false;

    void loadPreferences()
      .then((preferences) => {
        if (cancelled) {
          return;
        }

        setFontSize(normalizeTerminalFontSize(preferences.terminalFontSize));
        hasLoadedFontPreferenceRef.current = true;
      })
      .catch(() => {
        if (cancelled) {
          return;
        }

        hasLoadedFontPreferenceRef.current = true;
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasLoadedFontPreferenceRef.current) {
      return;
    }

    void savePreferencesPatch({
      terminalFontSize: normalizeTerminalFontSize(fontSize),
    });
  }, [fontSize]);

  useEffect(() => {
    const bootstrapAction = resolveTerminalRouteBootstrap({
      hasThread: selectedThread !== null,
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      hasOpened: hasOpenedRef.current,
      requestedTerminalId,
      currentTerminalId: terminalId,
      runningTerminalId: runningSession?.target.terminalId ?? null,
    });
    if (bootstrapAction.kind === "idle" || !selectedThread) {
      return;
    }

    if (bootstrapAction.kind === "redirect") {
      router.replace(buildThreadTerminalRoutePath(selectedThread, bootstrapAction.terminalId));
      return;
    }

    hasOpenedRef.current = true;
    void openTerminal().catch(() => {
      hasOpenedRef.current = false;
    });
  }, [
    openTerminal,
    requestedTerminalId,
    router,
    runningSession,
    selectedThread,
    selectedThreadProject?.workspaceRoot,
    terminalId,
  ]);

  useEffect(() => {
    setPendingModifier(null);
  }, [terminalId]);

  const writeInput = useCallback(
    (data: string) => {
      if (!selectedThread || !isRunning) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      void client.terminal.write({
        threadId: selectedThread.id,
        terminalId,
        data,
      });
    },
    [isRunning, selectedThread, terminalId],
  );

  const handleInput = useCallback(
    (data: string) => {
      if (data.length === 0) {
        return;
      }

      if (pendingModifier === "ctrl") {
        setPendingModifier(null);
        writeInput(applyCtrlModifier(data));
      } else if (pendingModifier === "meta") {
        setPendingModifier(null);
        writeInput(`\u001b${data}`);
      } else {
        writeInput(data);
      }
    },
    [pendingModifier, writeInput],
  );

  const handleResize = useCallback(
    (size: { readonly cols: number; readonly rows: number }) => {
      if (size.cols === lastGridSize.cols && size.rows === lastGridSize.rows) {
        return;
      }

      setLastGridSize(size);
      if (!selectedThread || !isRunning) {
        return;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return;
      }

      void client.terminal.resize({
        threadId: selectedThread.id,
        terminalId,
        cols: size.cols,
        rows: size.rows,
      });
    },
    [isRunning, lastGridSize.cols, lastGridSize.rows, selectedThread, terminalId],
  );

  const handleSelectTerminal = useCallback(
    (nextTerminalId: string) => {
      if (!selectedThread || nextTerminalId === terminalId) {
        return;
      }

      router.replace(buildThreadTerminalRoutePath(selectedThread, nextTerminalId));
    },
    [router, selectedThread, terminalId],
  );

  const handleOpenNewTerminal = useCallback(() => {
    if (!selectedThread) {
      return;
    }

    router.replace(
      buildThreadTerminalRoutePath(
        selectedThread,
        nextTerminalId(terminalMenuSessions.map((session) => session.terminalId)),
      ),
    );
  }, [router, selectedThread, terminalMenuSessions]);

  const adjustFontSize = useCallback((delta: number) => {
    setTimeout(() => {
      setFontSize((current) => normalizeTerminalFontSize(current + delta));
    }, 0);
  }, []);

  const handleDecreaseFontSize = useCallback(() => {
    adjustFontSize(-TERMINAL_FONT_SIZE_STEP);
  }, [adjustFontSize]);

  const handleIncreaseFontSize = useCallback(() => {
    adjustFontSize(TERMINAL_FONT_SIZE_STEP);
  }, [adjustFontSize]);

  const handleToolbarActionPress = useCallback(
    (action: TerminalToolbarAction) => {
      if (action.kind === "modifier") {
        setPendingModifier((current) => (current === action.modifier ? null : action.modifier));
        return;
      }

      setPendingModifier(null);
      if (pendingModifier === "ctrl") {
        writeInput(applyCtrlModifier(action.data));
      } else if (pendingModifier === "meta") {
        writeInput(`\u001b${action.data}`);
      } else {
        writeInput(action.data);
      }
    },
    [pendingModifier, writeInput],
  );

  if (!selectedThread) {
    if (isLoadingSavedConnection) {
      return <LoadingScreen message="Opening terminal…" />;
    }

    return (
      <View className="flex-1 bg-screen">
        <EmptyState
          title="Thread unavailable"
          detail="This terminal route needs an active thread and workspace."
        />
      </View>
    );
  }

  if (!selectedThreadProject?.workspaceRoot) {
    return (
      <View className="flex-1 bg-screen">
        <EmptyState
          title="Terminal unavailable"
          detail="This thread does not have a workspace root yet, so there is nowhere to open a shell."
        />
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          headerShown: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: { backgroundColor: "#0a0a0a" },
          headerTintColor: "#f5f5f5",
          headerTitleAlign: "center",
          title: "",
          headerTitle: () => (
            <View
              style={{
                alignItems: "center",
                gap: 1,
                maxWidth: 240,
              }}
            >
              <RNText
                numberOfLines={1}
                style={{
                  color: "#f5f5f5",
                  fontFamily: "DMSans_700Bold",
                  fontSize: 13,
                  lineHeight: 16,
                }}
              >
                {headerTitle.topLine}
              </RNText>
              <RNText
                ellipsizeMode="middle"
                numberOfLines={1}
                style={{
                  color: "#8f8f94",
                  fontFamily: "Menlo",
                  fontSize: 11,
                  lineHeight: 14,
                }}
              >
                {headerTitle.bottomLine}
              </RNText>
            </View>
          ),
        }}
      />

      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon="circle.fill"
          style={{
            color: terminalStatusTone.textColor,
            fontFamily: "DMSans_700Bold",
            fontSize: 12,
            fontWeight: "700",
          }}
          tintColor={terminalStatusTone.tintColor}
          title="Terminal options"
        >
          <Stack.Toolbar.Label>
            {getTerminalStatusLabel({
              status: terminal.status,
              hasRunningSubprocess: terminal.hasRunningSubprocess,
            })}
          </Stack.Toolbar.Label>
          <Stack.Toolbar.Menu icon="textformat.size" inline title="Text size">
            <Stack.Toolbar.Label>Text size</Stack.Toolbar.Label>
            <Stack.Toolbar.MenuAction
              disabled={fontSize <= MIN_TERMINAL_FONT_SIZE}
              discoverabilityLabel="Decrease terminal text size"
              onPress={handleDecreaseFontSize}
            >
              <Stack.Toolbar.Label>{`A- ${Math.max(MIN_TERMINAL_FONT_SIZE, fontSize - TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              disabled={fontSize >= MAX_TERMINAL_FONT_SIZE}
              discoverabilityLabel="Increase terminal text size"
              onPress={handleIncreaseFontSize}
            >
              <Stack.Toolbar.Label>{`A+ ${Math.min(MAX_TERMINAL_FONT_SIZE, fontSize + TERMINAL_FONT_SIZE_STEP).toFixed(1)} pt`}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          {terminalMenuSessions.map((session) => (
            <Stack.Toolbar.MenuAction
              key={session.terminalId}
              icon={session.terminalId === terminalId ? "checkmark" : "terminal"}
              onPress={() => handleSelectTerminal(session.terminalId)}
              subtitle={[getTerminalStatusLabel({ status: session.status }), basename(session.cwd)]
                .filter(Boolean)
                .join(" · ")}
            >
              <Stack.Toolbar.Label>{getTerminalLabel(session.terminalId)}</Stack.Toolbar.Label>
            </Stack.Toolbar.MenuAction>
          ))}
          <Stack.Toolbar.MenuAction
            icon="plus"
            onPress={handleOpenNewTerminal}
            subtitle={`Start another shell in ${basename(selectedThreadProject.workspaceRoot) ?? "this workspace"}`}
          >
            <Stack.Toolbar.Label>Open new terminal</Stack.Toolbar.Label>
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>

      <View style={{ flex: 1, backgroundColor: "#050505" }}>
        <Animated.View style={[{ flex: 1 }, terminalContainerAnimatedStyle]}>
          <TerminalSurface
            buffer={terminal.buffer}
            fontSize={fontSize}
            isRunning={isRunning}
            onInput={handleInput}
            onResize={handleResize}
            style={{ flex: 1 }}
            terminalKey={terminalKey}
          />
        </Animated.View>

        <KeyboardStickyView style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
          <View
            style={{
              backgroundColor: "#0a0a0a",
              borderTopColor: "rgba(255,255,255,0.08)",
              borderTopWidth: 1,
              minHeight: TERMINAL_ACCESSORY_HEIGHT,
              paddingBottom: 4,
              paddingHorizontal: 8,
              paddingTop: 4,
            }}
          >
            <ScrollView
              horizontal
              contentContainerStyle={{ alignItems: "center", gap: 6, paddingRight: 2 }}
              showsHorizontalScrollIndicator={false}
            >
              {terminalToolbarActions.map((action) => {
                const active = action.kind === "modifier" && pendingModifier === action.modifier;

                return (
                  <Pressable
                    key={action.key}
                    onPress={() => handleToolbarActionPress(action)}
                    style={({ pressed }) => ({
                      alignItems: "center",
                      backgroundColor: active
                        ? "rgba(74, 222, 128, 0.18)"
                        : pressed
                          ? "rgba(255,255,255,0.12)"
                          : "rgba(255,255,255,0.06)",
                      borderColor: active ? "rgba(74, 222, 128, 0.36)" : "rgba(255,255,255,0.08)",
                      borderRadius: 12,
                      borderWidth: 1,
                      justifyContent: "center",
                      minWidth: action.label.length > 1 ? 46 : 38,
                      paddingHorizontal: 11,
                      paddingVertical: 8,
                    })}
                  >
                    <RNText
                      style={{
                        color: active ? "#bbf7d0" : "#f5f5f5",
                        fontFamily: "DMSans_700Bold",
                        fontSize: 12,
                        fontWeight: "700",
                        textTransform: action.kind === "modifier" ? "uppercase" : "none",
                      }}
                    >
                      {action.label}
                    </RNText>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </KeyboardStickyView>
      </View>
    </>
  );
}
