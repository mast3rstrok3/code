import { describe, expect, it } from "vite-plus/test";

import { deriveAppDevStackNamespaceFromPath, normalizeKubernetesNamespace } from "./appDevStack.ts";

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
});
