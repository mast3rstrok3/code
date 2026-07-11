import { describe, expect, it } from "vite-plus/test";

import {
  appDevStackPreviewUrlForService,
  deriveAppDevStackNamespaceFromPath,
  normalizeKubernetesNamespace,
} from "./appDevStack.ts";

describe("app dev stack namespace helpers", () => {
  it("derives a repo-dev namespace from a worktree path", () => {
    expect(deriveAppDevStackNamespaceFromPath("/home/nils/repos/nils/hero")).toBe("hero-dev");
    expect(deriveAppDevStackNamespaceFromPath("/home/nils/repos/nils/rudi/")).toBe("rudi-dev");
  });

  it("normalizes free-form namespace input to a Kubernetes DNS label", () => {
    expect(normalizeKubernetesNamespace(" Hero Preview ")).toBe("hero-preview");
    expect(normalizeKubernetesNamespace("...")).toBe("app-dev");
  });

  it("keeps derived namespaces within Kubernetes DNS label limits", () => {
    const namespace = deriveAppDevStackNamespaceFromPath(
      "/worktrees/repository-name-that-is-far-too-long-for-a-single-kubernetes-namespace-label",
    );

    expect(namespace).toMatch(/-dev$/u);
    expect(namespace.length).toBeLessThanOrEqual(63);
  });

  it("derives conventional preview URLs for known app stack services", () => {
    expect(appDevStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "web" })).toBe(
      "https://hero-dev.nightingale-ai.com",
    );
    expect(appDevStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "app" })).toBe(
      "https://hero-dev.nightingale-ai.com",
    );
    expect(appDevStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "api" })).toBe(
      "https://api-hero-dev.nightingale-ai.com",
    );
    expect(
      appDevStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "keycloak" }),
    ).toBe("https://hero-dev-keycloak.nightingale-ai.com");
    expect(appDevStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "minio" })).toBe(
      "https://minio-hero-dev.nightingale-ai.com",
    );
  });

  it("prefers explicitly configured preview URL overrides", () => {
    expect(
      appDevStackPreviewUrlForService({
        namespace: "rudi-dev",
        serviceName: "frontend",
        frontendUrl: "https://custom-rudi.example.test",
      }),
    ).toBe("https://custom-rudi.example.test");
    expect(
      appDevStackPreviewUrlForService({
        namespace: "rudi-dev",
        serviceName: "backend",
        backendUrl: "https://custom-api.example.test",
      }),
    ).toBe("https://custom-api.example.test");
    expect(
      appDevStackPreviewUrlForService({
        namespace: "rudi-dev",
        serviceName: "keycloak",
        keycloakUrl: "https://custom-keycloak.example.test",
      }),
    ).toBe("https://custom-keycloak.example.test");
    expect(
      appDevStackPreviewUrlForService({
        namespace: "rudi-dev",
        serviceName: "minio",
        minioUrl: "https://custom-minio.example.test",
      }),
    ).toBe("https://custom-minio.example.test");
  });

  it("returns null for services without a conventional public URL", () => {
    expect(appDevStackPreviewUrlForService({ namespace: "hero-dev", serviceName: "worker" })).toBe(
      null,
    );
  });
});
