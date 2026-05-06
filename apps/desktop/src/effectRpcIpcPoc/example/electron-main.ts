import { Effect, Fiber } from "effect";
import { app, ipcMain } from "electron";

import { makeElectronIpcMainPort } from "../library/main.ts";
import { runDesktopIpcPocRpcServer } from "./main.ts";

export const runDesktopIpcPocElectronMainRpcServer = () =>
  runDesktopIpcPocRpcServer({
    port: makeElectronIpcMainPort(ipcMain),
    appVersion: app.getVersion(),
    platform: process.platform,
  });

export const startDesktopIpcPocElectronMainRpcServer = () => {
  const fiber = Effect.runFork(Effect.scoped(runDesktopIpcPocElectronMainRpcServer()));

  app.once("before-quit", () => {
    Effect.runFork(Fiber.interrupt(fiber));
  });

  return fiber;
};
