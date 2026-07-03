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

export const WORKSPACE_VIDEO_PREVIEW_EXTENSIONS = [".webm", ".mp4"] as const;

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
  return null;
}

export function isWorkspaceBrowserPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_BROWSER_PREVIEW_EXTENSIONS);
}

export function isWorkspaceImagePreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_IMAGE_PREVIEW_EXTENSIONS);
}

export function isWorkspaceVideoPreviewPath(path: string): boolean {
  return hasPreviewExtension(path, WORKSPACE_VIDEO_PREVIEW_EXTENSIONS);
}

export function isWorkspaceMediaPreviewPath(path: string): boolean {
  return isWorkspaceImagePreviewPath(path) || isWorkspaceVideoPreviewPath(path);
}

export function isWorkspacePreviewEntryPath(path: string): boolean {
  return isWorkspaceBrowserPreviewPath(path) || isWorkspaceMediaPreviewPath(path);
}
