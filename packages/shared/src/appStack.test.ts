import { describe, expect, it } from "vite-plus/test";

import {
  appStackComposePathForVariant,
  appStackPreviewUrlForService,
  appStackVariantForComposePath,
  appStackVariantForNamespace,
  deriveAppStackNamespaceFromPath,
  normalizeKubernetesNamespace,
} from "./appStack.ts";

describe("app stack namespace helpers", () => {
  it("derives a repo-dev namespace from a worktree path", () => {
    expect(deriveAppStackNamespaceFromPath("/home/nils/repos/nils/hero")).toBe("hero-dev");
    expect(deriveAppStackNamespaceFromPath("/home/nils/repos/nils/rudi/")).toBe("rudi-dev");
  });

  it("derives a repo-prod namespace for the prod variant", () => {
    expect(deriveAppStackNamespaceFromPath("/home/nils/repos/nils/hero", "prod")).toBe("hero-prod");
    expect(deriveAppStackNamespaceFromPath("/home/nils/repos/nils/hero-prod", "dev")).toBe(
      "hero-dev",
    );
  });

  it("normalizes free-form namespace input to a Kubernetes DNS label", () => {
    expect(normalizeKubernetesNamespace(" Hero Preview ")).toBe("hero-preview");
    expect(normalizeKubernetesNamespace("...")).toBe("app-dev");
  });

  it("keeps derived namespaces within Kubernetes DNS label limits", () => {
    const namespace = deriveAppStackNamespaceFromPath(
      "/worktrees/repository-name-that-is-far-too-long-for-a-single-kubernetes-namespace-label",
    );

    expect(namespace).toMatch(/-dev$/u);
    expect(namespace.length).toBeLessThanOrEqual(63);
  });

  it("derives conventional preview URLs for known app stack services", () => {
    expect(appStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "web" })).toBe(
      "https://hero-dev.nightingale-ai.com",
    );
    expect(appStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "app" })).toBe(
      "https://hero-dev.nightingale-ai.com",
    );
    expect(appStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "api" })).toBe(
      "https://api-hero-dev.nightingale-ai.com",
    );
    expect(appStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "keycloak" })).toBe(
      "https://hero-dev-keycloak.nightingale-ai.com",
    );
    expect(appStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "minio" })).toBe(
      "https://minio-hero-dev.nightingale-ai.com",
    );
  });

  it("prefers explicitly configured preview URL overrides", () => {
    expect(
      appStackPreviewUrlForService({
        namespace: "rudi-dev",
        serviceName: "frontend",
        frontendUrl: "https://custom-rudi.example.test",
      }),
    ).toBe("https://custom-rudi.example.test");
    expect(
      appStackPreviewUrlForService({
        namespace: "rudi-dev",
        serviceName: "backend",
        backendUrl: "https://custom-api.example.test",
      }),
    ).toBe("https://custom-api.example.test");
    expect(
      appStackPreviewUrlForService({
        namespace: "rudi-dev",
        serviceName: "keycloak",
        keycloakUrl: "https://custom-keycloak.example.test",
      }),
    ).toBe("https://custom-keycloak.example.test");
    expect(
      appStackPreviewUrlForService({
        namespace: "rudi-dev",
        serviceName: "minio",
        minioUrl: "https://custom-minio.example.test",
      }),
    ).toBe("https://custom-minio.example.test");
  });

  it("returns null for services without a conventional public URL", () => {
    expect(appStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "worker" })).toBe(
      null,
    );
  });
});

describe("app stack variants", () => {
  it("reads the variant from the compose file name", () => {
    expect(appStackVariantForComposePath("infra/compose/compose.app-dev.yml")).toBe("dev");
    expect(appStackVariantForComposePath("infra/compose/compose.app-prod.yml")).toBe("prod");
    expect(appStackVariantForComposePath("/abs/compose.prod-stack.yaml")).toBe("prod");
    expect(appStackVariantForComposePath("compose.yml")).toBe("dev");
    expect(appStackVariantForComposePath(undefined)).toBe("dev");
  });

  it("derives the prod contract path next to the dev one", () => {
    expect(appStackComposePathForVariant("infra/compose/compose.app-dev.yml", "dev")).toBe(
      "infra/compose/compose.app-dev.yml",
    );
    expect(appStackComposePathForVariant("infra/compose/compose.app-dev.yml", "prod")).toBe(
      "infra/compose/compose.app-prod.yml",
    );
    expect(appStackComposePathForVariant("/srv/stacks/compose.app-dev.yaml", "prod")).toBe(
      "/srv/stacks/compose.app-prod.yaml",
    );
    expect(appStackComposePathForVariant("deploy/custom.yml", "prod")).toBe(
      "infra/compose/compose.app-prod.yml",
    );
    expect(appStackComposePathForVariant("infra/compose/compose.app-prod.yml", "prod")).toBe(
      "infra/compose/compose.app-prod.yml",
    );
    expect(appStackComposePathForVariant("infra/compose/compose.app-prod.yml", "dev")).toBe(
      "infra/compose/compose.app-dev.yml",
    );
  });

  it("falls back to the namespace suffix for the variant", () => {
    expect(appStackVariantForNamespace("hero-prod")).toBe("prod");
    expect(appStackVariantForNamespace("hero-dev")).toBe("dev");
    expect(appStackVariantForNamespace("rudi")).toBe("dev");
  });
});
