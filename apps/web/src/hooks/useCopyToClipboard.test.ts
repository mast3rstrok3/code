import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";

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
  it("reserves plain text even when an extra flavor attempts to replace it", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    await expect(
      writeTextToClipboard("original", "message", {
        "text/plain": "replacement",
        "text/html": "<b>original</b>",
      }),
    ).resolves.toBe(true);
    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    expect(await items[0]!.data["text/plain"]!.text()).toBe("original");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps caller-built rich HTML when attaching a context fragment", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    const fragment = JSON.stringify({ version: 1, source: {}, records: [] });
    const rich = "<p><strong>Message</strong></p>";

    await expect(
      writeTextToClipboard("Message", "message", {
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment,
        "text/html": rich,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    const html = await items[0]!.data["text/html"]!.text();
    expect(html).toContain(rich);
    expect(html).toContain("data-t3-context-fragment=");
  });
});
