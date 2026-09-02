import { VIDEO_FILE_EXTENSIONS, videoMimeType } from "./video.ts";

export const WORKSPACE_BROWSER_PREVIEW_EXTENSIONS = [".htm", ".html", ".pdf"] as const;

export const WORKSPACE_IMAGE_PREVIEW_EXTENSIONS = [
  ".avif",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".png",
  ".svg",
  ".webp",
] as const;

export const WORKSPACE_VIDEO_PREVIEW_EXTENSIONS = VIDEO_FILE_EXTENSIONS.map(
  (extension) => `.${extension}`,
);

const WORKSPACE_PREVIEW_MIME_TYPES = {
  ".htm": "text/html; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".pdf": "application/pdf",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
} as const;

export type WorkspacePreviewMimeType =
  (typeof WORKSPACE_PREVIEW_MIME_TYPES)[keyof typeof WORKSPACE_PREVIEW_MIME_TYPES];

function previewPathWithoutQuery(path: string): string {
  return path.split(/[?#]/, 1)[0]?.toLowerCase() ?? "";
}

/** Classifies a literal filesystem extension, without URL decoding or suffix removal. */
export function mediaMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  const known =
    WORKSPACE_PREVIEW_MIME_TYPES[
      extension.toLowerCase() as keyof typeof WORKSPACE_PREVIEW_MIME_TYPES
    ];
  return known?.startsWith("image/") === true
    ? known
    : videoMimeType({ name: `media${extension}`, mimeType: "" });
}

/** Files the server serves in place from anywhere on its host. */
export function hostPreviewMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  return (
    mediaMimeTypeFromExtension(extension) ??
    WORKSPACE_PREVIEW_MIME_TYPES[
      extension.toLowerCase() as keyof typeof WORKSPACE_PREVIEW_MIME_TYPES
    ] ??
    null
  );
}

/** Classifies an authored media path or URL. Filesystem validation uses the literal extension. */
export function mediaMimeType(path: string): string | null {
  const trimmed = path.trim();
  const source = trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1) : trimmed;
  const dataMimeType = /^data:((?:image|video)\/[\w.+-]+)[;,]/i.exec(source)?.[1];
  if (dataMimeType) return dataMimeType.toLowerCase();

  let sourcePath = source.split(/[?#]/, 1)[0] ?? "";
  if (/^(?:https?:|file:|\/\/)/i.test(source)) {
    try {
      sourcePath = new URL(source, "https://media.invalid").pathname;
    } catch {
      return null;
    }
  }
  try {
    sourcePath = decodeURIComponent(sourcePath);
  } catch {
    // A literal percent character is valid in a filename.
  }
  const basename = sourcePath.split(/[\\/]/).at(-1) ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex < 0 ? null : mediaMimeTypeFromExtension(basename.slice(extensionIndex));
}

export function mediaKindFromPath(path: string): "image" | "video" | null {
  const mimeType = mediaMimeType(path);
  if (mimeType === null) return null;
  return mimeType.startsWith("video/") ? "video" : "image";
}

function hasPreviewExtension(path: string, extensions: ReadonlyArray<string>): boolean {
  const pathWithoutQuery = previewPathWithoutQuery(path);
  return extensions.some((extension) => pathWithoutQuery.endsWith(extension));
}

export function workspacePreviewMimeType(path: string): WorkspacePreviewMimeType | null {
  const pathWithoutQuery = previewPathWithoutQuery(path);
  for (const extension of Object.keys(WORKSPACE_PREVIEW_MIME_TYPES) as ReadonlyArray<
    keyof typeof WORKSPACE_PREVIEW_MIME_TYPES
  >) {
    if (pathWithoutQuery.endsWith(extension)) {
      return WORKSPACE_PREVIEW_MIME_TYPES[extension];
    }
  }
  const basename = pathWithoutQuery.split(/[\\/]/).at(-1) ?? "";
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex < 0
    ? null
    : (hostPreviewMimeTypeFromExtension(
        basename.slice(extensionIndex),
      ) as WorkspacePreviewMimeType);
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
}

export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return videoMimeType({ name: path, mimeType: "" }) !== null;
}

export function isWorkspaceMediaPreviewPath(path: string): boolean {
  return isWorkspaceImagePreviewPath(path) || isWorkspaceVideoPreviewPath(path);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceMediaPreviewPath(path);
}
