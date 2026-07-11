const DNS_LABEL_MAX_LENGTH = 63;
export const DEFAULT_APP_DEV_STACK_PREVIEW_DOMAIN = "nightingale-ai.com";

export interface AppDevStackPreviewUrlConfig {
  readonly namespace: string;
  readonly serviceName: string;
  readonly frontendUrl?: string | null | undefined;
  readonly backendUrl?: string | null | undefined;
  readonly keycloakUrl?: string | null | undefined;
  readonly minioUrl?: string | null | undefined;
  readonly domain?: string | null | undefined;
}

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

function normalizeKubernetesName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function appDevStackPreviewUrlForService(
  config: AppDevStackPreviewUrlConfig,
): string | null {
  const namespace = normalizeKubernetesNamespace(config.namespace);
  const serviceName = normalizeKubernetesName(config.serviceName);
  const domain = nonEmpty(config.domain) ?? DEFAULT_APP_DEV_STACK_PREVIEW_DOMAIN;

  switch (serviceName) {
    case "frontend":
    case "web":
    case "app":
      return nonEmpty(config.frontendUrl) ?? `https://${namespace}.${domain}`;
    case "backend":
    case "api":
      return nonEmpty(config.backendUrl) ?? `https://api-${namespace}.${domain}`;
    case "keycloak":
      return nonEmpty(config.keycloakUrl) ?? `https://${namespace}-keycloak.${domain}`;
    case "minio":
      return nonEmpty(config.minioUrl) ?? `https://minio-${namespace}.${domain}`;
    default:
      return null;
  }
}
