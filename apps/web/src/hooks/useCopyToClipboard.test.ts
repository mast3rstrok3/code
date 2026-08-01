import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ClipboardApiUnavailableError,
  ClipboardReadApiUnavailableError,
  ClipboardReadError,
  ClipboardWriteError,
  readTextFromClipboard,
  writeTextToClipboard,
} from "./useCopyToClipboard";

describe("readTextFromClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads clipboard text exactly", async () => {
    const value = "long-secret-🔐\nsecond line";
    const readText = vi.fn().mockResolvedValue(value);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { readText } });

    await expect(readTextFromClipboard("terminal input")).resolves.toBe(value);
    expect(readText).toHaveBeenCalledOnce();
  });

  it("reports unavailable clipboard reads without exposing the target contents", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});

    const error = await readTextFromClipboard("terminal input").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClipboardReadApiUnavailableError);
    expect(error).toMatchObject({
      target: "terminal input",
    });
  });

  it("preserves clipboard read failures without exposing clipboard contents", async () => {
    const cause = new Error("browser clipboard failure");
    const readText = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { readText } });

    const error = await readTextFromClipboard("terminal input").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(ClipboardReadError);
    expect(error).toMatchObject({
      target: "terminal input",
      cause,
    });
    expect((error as Error).message).not.toContain("browser clipboard failure");
  });
});

describe("writeTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unavailable clipboard support with structural context", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});

    const error = await writeTextToClipboard("plan contents", "plan").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(error).toMatchObject({
      target: "plan",
    });
    expect((error as Error).message).not.toContain("plan contents");
  });

  it("preserves the exact clipboard failure without exposing copied contents", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const error = await writeTextToClipboard("secret clipboard contents", "error-message").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(writeText).toHaveBeenCalledWith("secret clipboard contents");
    expect(error).toBeInstanceOf(ClipboardWriteError);
    expect(error).toMatchObject({
      target: "error-message",
      cause,
    });
    expect((error as Error).message).not.toContain("secret clipboard contents");
  });

  it("keeps empty values as a no-op when clipboard support is available", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(writeTextToClipboard("", "plan")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});
