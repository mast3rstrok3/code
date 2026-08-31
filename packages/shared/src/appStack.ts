const DNS_LABEL_MAX_LENGTH = 63;
export const DEFAULT_APP_STACK_PREVIEW_DOMAIN = "nightingale-ai.com";

export type AppStackVariant = "dev" | "prod";
export const APP_STACK_VARIANTS: ReadonlyArray<AppStackVariant> = ["dev", "prod"];
export const DEFAULT_APP_STACK_COMPOSE_PATHS: Readonly<Record<AppStackVariant, string>> = {
  dev: "infra/compose/compose.app-dev.yml",
  prod: "infra/compose/compose.app-prod.yml",
};

/**
 * The variant lives in the compose file name, never in stored state, so a
 * restart lands on the same contract. Same rule as the Stacks controller.
 */
export function appStackVariantForComposePath(
  composePath: string | null | undefined,
): AppStackVariant {
  const name = basenameFromPath(composePath ?? "").toLowerCase();
  return name.includes("app-prod") || name.includes("prod-stack") ? "prod" : "dev";
}

/**
 * The two contracts sit next to each other, so the other variant's path is the
 * same file with the variant swapped. A custom file name has no sibling to
 * derive and falls back to the conventional path.
 */
export function appStackComposePathForVariant(
  composePath: string,
  variant: AppStackVariant,
): string {
  const current = appStackVariantForComposePath(composePath);
  if (current === variant) return composePath;
  const base = basenameFromPath(composePath);
  const swapped = base.replace(`app-${current}`, `app-${variant}`);
  if (swapped !== base) return composePath.slice(0, composePath.length - base.length) + swapped;
  return DEFAULT_APP_STACK_COMPOSE_PATHS[variant];
}

/** Fallback for namespaces created before the variant annotation existed. */
export function appStackVariantForNamespace(namespace: string): AppStackVariant {
  return namespace.endsWith("-prod") ? "prod" : "dev";
}

export interface AppStackPreviewUrlConfig {
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

function repoNameFromWorktreePath(worktreePath: string): string {
  const trimmed = worktreePath.trim().replace(/[\\/]+$/gu, "");
  const parts = trimmed.split(/[\\/]+/u).filter((part) => part.length > 0);
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]!;
    // Sibling-worktree convention: <repo>.worktrees/<name>
    if (part.endsWith(".worktrees") && part.length > ".worktrees".length) {
      return part.slice(0, -".worktrees".length);
    }
    // Nested convention: <repo>/worktrees/<name>
    if (part === "worktrees" && index > 0) {
      return parts[index - 1]!;
    }
  }
  return basenameFromPath(trimmed) || "app";
}

/**
 * Display name driving the stack's preview hostnames: the controller slugs it
 * into `<slug>-<service>-<shortuuid>` subdomains, so "code fix-auth" yields
 * code-fix-auth-frontend-<uuid> URLs named after the app and branch.
 */
export function appStackDisplayName(worktreePath: string, branch?: string | null): string {
  const repo = repoNameFromWorktreePath(worktreePath);
  const trimmedBranch = branch?.trim();
  return trimmedBranch ? `${repo} ${trimmedBranch}` : repo;
}

export function deriveAppStackNamespaceFromPath(
  worktreePath: string,
  variant: AppStackVariant = "dev",
): string {
  const repoSlug = normalizeKubernetesNamespace(basenameFromPath(worktreePath), "app");
  const baseSlug = repoSlug.replace(/-(?:dev|prod)$/u, "");
  const suffix = `-${variant}`;
  const maxBaseLength = DNS_LABEL_MAX_LENGTH - suffix.length;
  const boundedBase = trimDnsLabel(baseSlug.slice(0, maxBaseLength), "app");
  return `${boundedBase}${suffix}`;
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

export function appStackPreviewUrlForService(config: AppStackPreviewUrlConfig): string | null {
  const namespace = normalizeKubernetesNamespace(config.namespace);
  const serviceName = normalizeKubernetesName(config.serviceName);
  const domain = nonEmpty(config.domain) ?? DEFAULT_APP_STACK_PREVIEW_DOMAIN;

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
