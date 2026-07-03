import {
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@t3tools/shared/filePreview";

export type WorkspaceFilePreviewKind = "image" | "video" | "text";

export function resolveWorkspaceFilePreviewKind(path: string): WorkspaceFilePreviewKind {
  if (isWorkspaceImagePreviewPath(path)) return "image";
  if (isWorkspaceVideoPreviewPath(path)) return "video";
  return "text";
}
