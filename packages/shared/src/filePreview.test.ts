import { describe, expect, it } from "vite-plus/test";

import {
  isWorkspaceBrowserPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceMediaPreviewPath,
  isWorkspacePreviewEntryPath,
  isWorkspaceVideoPreviewPath,
  workspacePreviewMimeType,
} from "./filePreview.ts";

describe("workspace file previews", () => {
  it.each(["report.html", "report.HTM", "document.pdf?download=1"])(
    "recognizes browser preview path %s",
    (path) => {
      expect(isWorkspaceBrowserPreviewPath(path)).toBe(true);
      expect(isWorkspacePreviewEntryPath(path)).toBe(true);
    },
  );

  it.each([
    "icon.png",
    "photo.JPEG",
    "animation.gif",
    "vector.svg#mark",
    "texture.webp",
    "image.avif",
  ])("recognizes image preview path %s", (path) => {
    expect(isWorkspaceImagePreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["recording.webm", "clip.MP4?download=1"])("recognizes video preview path %s", (path) => {
    expect(isWorkspaceVideoPreviewPath(path)).toBe(true);
    expect(isWorkspaceMediaPreviewPath(path)).toBe(true);
    expect(isWorkspacePreviewEntryPath(path)).toBe(true);
  });

  it.each(["README.md", "src/index.ts", "image.png.ts", "png"])(
    "rejects non-preview path %s",
    (path) => {
      expect(isWorkspacePreviewEntryPath(path)).toBe(false);
    },
  );

  it.each([
    ["recording.webm", "video/webm"],
    ["clip.MP4?download=1", "video/mp4"],
    ["icon.png", "image/png"],
    ["photo.jpeg", "image/jpeg"],
    ["vector.svg#mark", "image/svg+xml"],
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
});
