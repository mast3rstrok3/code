const DNS_LABEL_MAX_LENGTH = 63;

function trimDnsLabel(value: string, fallback: string): string {
  const trimmed = value.slice(0, DNS_LABEL_MAX_LENGTH).replace(/-+$/u, "").replace(/^-+/u, "");
  return trimmed.length > 0 ? trimmed : fallback;
}

export function normalizeKubernetesNamespace(value: string, fallback = "app-dev"): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return trimDnsLabel(normalized, fallback);
}

function basenameFromPath(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/gu, "");
  const separatorIndex = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1);
}

export function deriveAppDevStackNamespaceFromPath(worktreePath: string): string {
  const repoSlug = normalizeKubernetesNamespace(basenameFromPath(worktreePath), "app");
  const baseSlug = repoSlug.endsWith("-dev") ? repoSlug.slice(0, -4) : repoSlug;
  const maxBaseLength = DNS_LABEL_MAX_LENGTH - "-dev".length;
  const boundedBase = trimDnsLabel(baseSlug.slice(0, maxBaseLength), "app");
  return `${boundedBase}-dev`;
}
