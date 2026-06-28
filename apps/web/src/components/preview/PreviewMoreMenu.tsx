"use client";

import { Minus, MoreVertical, Plus as PlusIcon, RotateCcw } from "lucide-react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

interface Props {
  /** Active preview tab id. Tab-targeting actions are disabled without it. */
  tabId: string | null;
  /**
   * True only after the desktop bridge has registered a `webContentsId` for
   * the active tab. Tab-targeting actions throw on the desktop side until
   * then; we disable those items so the menu doesn't fire silent no-ops.
   */
  hasWebContents: boolean;
  /** Current zoom factor as a number (1.0 = 100%). */
  zoomFactor: number;
  /** Fixed viewport modes expose the device toolbar and resize rails. */
  deviceToolbarVisible: boolean;
  /** Switches between fill-panel mode and a fixed responsive viewport. */
  onToggleDeviceToolbar: () => void;
  readonly onHardReload: (() => void) | undefined;
  readonly onOpenDevTools?: (() => void) | undefined;
  readonly onZoomIn: (() => void) | undefined;
  readonly onZoomOut: (() => void) | undefined;
  readonly onResetZoom: (() => void) | undefined;
  readonly onClearCookies: () => void;
  readonly onClearCache: () => void;
}

/**
 * Three-dot menu in the chrome row. Wires Hard reload, DevTools, zoom
 * controls, and storage-clearing actions. Only mounted by `PreviewView`
 * when the desktop bridge is present, so we can call it unconditionally.
 */
export function PreviewMoreMenu({
  tabId,
  hasWebContents,
  zoomFactor,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  onHardReload,
  onOpenDevTools,
  onZoomIn,
  onZoomOut,
  onResetZoom,
  onClearCookies,
  onClearCache,
}: Props) {
  const tabDisabled = !tabId || !hasWebContents;

  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button variant="ghost" size="icon-xs" type="button" aria-label="Preview menu" />
              }
            />
          }
        >
          <MoreVertical />
        </TooltipTrigger>
        <TooltipPopup>More</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        <MenuItem onClick={onHardReload} disabled={tabDisabled || !onHardReload}>
          Hard reload
        </MenuItem>
        {onOpenDevTools ? (
          <MenuItem onClick={onOpenDevTools} disabled={tabDisabled}>
            Open DevTools
          </MenuItem>
        ) : null}
        <MenuItem onClick={onToggleDeviceToolbar} disabled={tabDisabled}>
          {deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
        </MenuItem>
        <MenuSeparator />
        {/*
          Zoom row: label + inline control cluster. `closeOnClick=false`
          keeps the menu open while the user clicks the +/− buttons.
        */}
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between"
          disabled={tabDisabled}
        >
          <span>Zoom</span>
          <span className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={onZoomOut}
              aria-label="Zoom out"
              disabled={tabDisabled || !onZoomOut}
            >
              <Minus />
            </Button>
            <span className="min-w-12 text-center text-xs tabular-nums text-muted-foreground">
              {zoomLabel}
            </span>
            <Button
              variant="outline"
              size="icon-xs"
              type="button"
              onClick={onZoomIn}
              aria-label="Zoom in"
              disabled={tabDisabled || !onZoomIn}
            >
              <PlusIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={onResetZoom}
              aria-label="Reset zoom"
              disabled={tabDisabled || !onResetZoom}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onClearCookies}>Clear cookies</MenuItem>
        <MenuItem onClick={onClearCache}>Clear cache</MenuItem>
      </MenuPopup>
    </Menu>
  );
}
