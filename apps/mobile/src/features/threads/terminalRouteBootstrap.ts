export function resolveTerminalRouteBootstrap(input: {
  readonly hasThread: boolean;
  readonly hasWorkspaceRoot: boolean;
  readonly hasOpened: boolean;
  readonly requestedTerminalId: string | null;
  readonly currentTerminalId: string;
  readonly runningTerminalId: string | null;
}):
  | { readonly kind: "idle" }
  | { readonly kind: "redirect"; readonly terminalId: string }
  | { readonly kind: "open" } {
  if (!input.hasThread || !input.hasWorkspaceRoot || input.hasOpened) {
    return { kind: "idle" };
  }

  if (
    input.requestedTerminalId === null &&
    input.runningTerminalId !== null &&
    input.runningTerminalId !== input.currentTerminalId
  ) {
    return { kind: "redirect", terminalId: input.runningTerminalId };
  }

  return { kind: "open" };
}
