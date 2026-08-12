import type { PreviewPanelMode } from "./preview/PreviewPanelShell";

export const RIGHT_PANEL_EMPTY_STATE_CLASS_NAME =
  "flex h-full min-h-0 flex-1 overflow-y-auto overscroll-contain p-6";

export function rightPanelTabIconClassNames(mode: PreviewPanelMode): {
  surfaceIcon: string;
  closeIcon: string;
} {
  if (mode === "sheet") {
    return {
      surfaceIcon: "relative hidden size-3 items-center justify-center",
      closeIcon: "block size-3",
    };
  }

  return {
    surfaceIcon:
      "relative flex size-3 items-center justify-center group-hover/tab:hidden group-focus-visible/close:hidden",
    closeIcon: "hidden size-3 group-hover/tab:block group-focus-visible/close:block",
  };
}
