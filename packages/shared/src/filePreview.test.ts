import { describe, expect, it } from "vite-plus/test";

import {
  filePreviewKind,
  decodeFilePreviewText,
  FILE_TEXT_PREVIEW_MAX_BYTES,
  hostPreviewMimeTypeFromExtension,
  isWorkspaceAudioPreviewPath,
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceMediaPreviewPath,
  isWorkspacePreviewEntryPath,
  mediaKindFromPath,
  workspacePreviewMimeType,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  // regression: #10311 previews classify by the literal filename, not URL-like suffixes
  it.each(["image.png.ts", "image.png#notes.txt", "image%2Epng"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );

  it.each([
    "icon.png",
    "photo.JPEG",
    "animation.gif",
    "vector#mark.svg",
    "photo?edited.JPEG",
    "images#archive/icon.png",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["recording.webm", "clip.MP4"])("recognizes video preview path %s", (path) => {
    expect(isWorkspaceVideoPreviewPath(path)).toBe(true);
    expect(isWorkspaceMediaPreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each([
    "README.md",
    "src/index.ts",
    "image.png.ts",
    "png",
    "image.png#notes.txt",
    "image.svg?notes.txt",
    "document.pdf?download=1",
    "report.html#notes.txt",
    "image%2Epng",
  ])("rejects non-preview path %s", (path) => {
    expect(isWorkspacePreviewEntryPath(path)).toBe(false);
  });

  it.each([
    ["recording.webm", "video/webm"],
    ["clip.MP4", "video/mp4"],
    ["icon.png", "image/png"],
    ["photo.jpeg", "image/jpeg"],
    ["vector.svg", "image/svg+xml"],
    ["animation.gif", "image/gif"],
    ["texture.webp", "image/webp"],
    ["image.avif", "image/avif"],
    ["favicon.ico", "image/x-icon"],
    ["document.pdf", "application/pdf"],
    ["report.html", "text/html; charset=utf-8"],
  ])("resolves preview MIME type for %s", (path, mimeType) => {
    expect(workspacePreviewMimeType(path)).toBe(mimeType);
  });

  it("returns null for unknown preview MIME types", () => {
    expect(workspacePreviewMimeType("src/index.ts")).toBeNull();
    expect(workspacePreviewMimeType("archive.webm.txt")).toBeNull();
  });

  it("serves audio in place from the host like video and browser documents", () => {
    expect(isWorkspaceAudioPreviewPath("notes/recording.WAV")).toBe(true);
    expect(isWorkspaceAudioPreviewPath("recording.wav.ts")).toBe(false);
    expect(hostPreviewMimeTypeFromExtension(".m4a")).toBe("audio/mp4");
    expect(hostPreviewMimeTypeFromExtension(".mp4")).toBe("video/mp4");
    expect(hostPreviewMimeTypeFromExtension(".txt")).toBeNull();
  });
});

describe("media path parsing", () => {
  // regression: #9023 media kind comes from the decoded pathname, ignoring query and hash
  it.each([
    ["https://cdn.example/clip.webm?download=1#t=2", "video"],
    ["https://example.com/download?name=recording.mp4", null],
    ["images%2Fresult%2Epng", "image"],
    ["images/result.png%23secret.txt", null],
  ])("classifies the decoded pathname of %s", (source, kind) => {
    expect(mediaKindFromPath(source)).toBe(kind);
  });
});

describe("attachment preview classification", () => {
  it.each([
    ["example.json", "application/octet-stream", "text"],
    ["payload", "application/problem+json", "text"],
    ["misleading.json", "application/pdf", "pdf"],
    ["misleading.pdf", "application/zip", "unsupported"],
  ])("classifies %s (%s) as %s", (name, mimeType, expected) => {
    expect(filePreviewKind({ name, mimeType })).toBe(expected);
  });
  it("rejects binary and invalid UTF-8 data", () => {
    expect(() => decodeFilePreviewText(new Uint8Array([65, 0, 66]))).toThrow("binary");
    expect(() => decodeFilePreviewText(new Uint8Array([255]))).toThrow("UTF-8");
  });
  it("does not corrupt a multi-byte character at the preview boundary", () => {
    const bytes = new Uint8Array(FILE_TEXT_PREVIEW_MAX_BYTES + 1).fill(97);
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES - 1] = 0xe2;
    bytes[FILE_TEXT_PREVIEW_MAX_BYTES] = 0x82;
    const preview = decodeFilePreviewText(bytes);
    expect(preview.truncated).toBe(true);
    expect(preview.text.endsWith("�")).toBe(false);
    expect(preview.text.length).toBe(FILE_TEXT_PREVIEW_MAX_BYTES - 1);
  });
});
