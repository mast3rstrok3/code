import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { NativeAppDevStackConfig } from "../config.ts";
import { makeNativeAppDevStackService, type KubectlRunner } from "./NativeAppDevStackManager.ts";

const nativeConfig = {
  id: "rudi-dev",
  namespace: "rudi-dev",
  worktreePath: "/home/nils/repos/nils/rudi",
  composePath: "infra/compose/compose.app-dev.yml",
  displayName: "rudi",
  displaySlug: "rudi",
  repoName: "rudi",
  branchName: "dev",
  kubectlPath: "kubectl",
  frontendUrl: "https://rudi-dev.nightingale-ai.com",
  backendUrl: "https://api-rudi-dev.nightingale-ai.com",
  keycloakUrl: "https://rudi-dev-keycloak.nightingale-ai.com",
  minioUrl: "https://minio-rudi-dev.nightingale-ai.com",
} satisfies NativeAppDevStackConfig;

const namespaceJson = JSON.stringify({
  metadata: { creationTimestamp: "2026-06-25T15:50:50.000Z" },
});

const deploymentsJson = JSON.stringify({
  items: [
    {
      metadata: { name: "backend" },
      spec: { replicas: 1 },
      status: { availableReplicas: 1, readyReplicas: 1 },
    },
    {
      metadata: { name: "frontend" },
      spec: { replicas: 1 },
      status: { availableReplicas: 1, readyReplicas: 1 },
    },
  ],
});

it.effect("reports the configured Rudi stack from Kubernetes deployments", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace rudi-dev -o json") return namespaceJson;
    if (args.join(" ") === "-n rudi-dev get deployments -o json") return deploymentsJson;
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.getByWorktree({ worktreePath: "/home/nils/repos/nils/rudi/" });

    assert.equal(result.frontendUrl, "https://rudi-dev.nightingale-ai.com");
    assert.equal(result.frontendServiceName, "frontend");
    assert.equal(result.stack?.status, "running");
    assert.equal(result.stack?.namespace, "rudi-dev");
    assert.deepEqual(
      result.stack?.services?.map((item) => [item.name, item.status, item.previewUrl]),
      [
        ["frontend", "running", "https://rudi-dev.nightingale-ai.com"],
        ["backend", "running", "https://api-rudi-dev.nightingale-ai.com"],
      ],
    );
    assert.deepEqual(calls, [
      ["get", "namespace", "rudi-dev", "-o", "json"],
      ["-n", "rudi-dev", "get", "deployments", "-o", "json"],
    ]);
  });
});

it.effect("scales deployments when auto-creating an existing native stack", () => {
  const calls: Array<ReadonlyArray<string>> = [];
  const runKubectl: KubectlRunner = async (args) => {
    calls.push(args);
    if (args.join(" ") === "get namespace rudi-dev -o json") return namespaceJson;
    if (args.join(" ") === "-n rudi-dev get deployments -o json") return deploymentsJson;
    if (args.join(" ") === "-n rudi-dev scale deployment --all --replicas=1") return "";
    throw new Error(`unexpected kubectl call: ${args.join(" ")}`);
  };
  const service = makeNativeAppDevStackService(nativeConfig, runKubectl);

  return Effect.gen(function* () {
    const result = yield* service.autoCreate({
      worktreePath: "/home/nils/repos/nils/rudi",
      displayName: "rudi",
      gitBranch: "dev",
    });

    assert.equal(result.created, false);
    assert.equal(result.stack.status, "running");
    assert.deepEqual(calls, [
      ["get", "namespace", "rudi-dev", "-o", "json"],
      ["-n", "rudi-dev", "scale", "deployment", "--all", "--replicas=1"],
      ["get", "namespace", "rudi-dev", "-o", "json"],
      ["-n", "rudi-dev", "get", "deployments", "-o", "json"],
    ]);
  });
});
