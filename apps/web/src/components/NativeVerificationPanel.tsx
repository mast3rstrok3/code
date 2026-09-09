import { useState } from "react";
import {
  EnvironmentId,
  ProjectId,
  type NativeVerificationHandoff,
  type NativeVerificationPlatform,
  type NativeVerificationRequest,
  type NativeVerificationResponse,
  type OrchestrationImplementationTicketState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { createNativeVerificationCommand } from "@t3tools/client-runtime/state/native-verification";
import { connectionAtomRuntime } from "../connection/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments } from "../state/environments";
import { Button } from "./ui/button";
import { newThreadId } from "../lib/utils";

const command = createNativeVerificationCommand(connectionAtomRuntime);
const labels: Record<NativeVerificationPlatform, string> = {
  macos: "macOS",
  ios: "iOS",
  windows: "Windows",
  android: "Android",
};

export function NativeVerificationPanel(props: {
  environmentId: EnvironmentId;
  runId: string;
  ticket: OrchestrationImplementationTicketState;
}) {
  const invoke = useAtomCommand(command, { reportFailure: false, reportDefect: false });
  const { environments } = useEnvironments();
  const [updated, setUpdated] = useState<NativeVerificationHandoff | null>(null);
  const [platforms, setPlatforms] = useState<NativeVerificationPlatform[]>(["macos"]);
  const [targetId, setTargetId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [platform, setPlatform] = useState<NativeVerificationPlatform>("macos");
  const [capabilities, setCapabilities] = useState<Extract<
    NativeVerificationResponse,
    { type: "capabilities" }
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const persisted = props.ticket.nativeVerification;
  const handoff =
    updated && (!persisted || updated.revision > persisted.revision) ? updated : persisted;
  const target = { runId: props.runId, ticketId: props.ticket.ticketId };
  const call = async (environmentId: EnvironmentId, input: NativeVerificationRequest) => {
    const response = await invoke({ environmentId, input });
    if (response._tag !== "Success") throw Cause.squash(response.cause);
    if (response.value.type === "handoff") setUpdated(response.value.handoff);
    return response.value;
  };
  const act = (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    void work()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const prepare = () =>
    act(async () => {
      const [first, ...rest] =
        handoff?.status === "completed" ? handoff.requiredPlatforms : platforms;
      if (!first) throw new Error("Select at least one platform.");
      await call(props.environmentId, {
        operation: "prepare",
        ...target,
        platforms: [first, ...rest],
      });
    });
  const claim = () =>
    act(async () => {
      if (!handoff) return;
      const local = environments.find((environment) => environment.environmentId === targetId);
      if (!local || !projectId)
        throw new Error("Select the environment and its local repository project.");
      const response = await call(props.environmentId, {
        operation: "claim",
        ...target,
        revision: handoff.revision,
        claim: {
          id: newThreadId(),
          environmentId: local.environmentId,
          environmentLabel: local.label,
          threadId: newThreadId(),
          projectId: ProjectId.make(projectId),
          platform,
          claimedAt: new Date().toISOString(),
        },
      });
      if (response.type !== "handoff") return;
      // Keep the durable claim on checkout failure so retrying uses the same thread and worktree.
      await call(local.environmentId, {
        operation: "checkout",
        handoff: response.handoff,
        projectId: ProjectId.make(projectId),
      });
    });
  const submit = () =>
    act(async () => {
      if (!handoff?.claim) return;
      const report = await call(EnvironmentId.make(handoff.claim.environmentId), {
        operation: "report",
        handoff,
      });
      if (report.type !== "report") return;
      await call(props.environmentId, {
        operation: "submit",
        ...target,
        revision: handoff.revision,
        claimId: handoff.claim.id,
        result: report.result,
      });
    });
  return (
    <details className="mb-3 rounded-md border border-border p-2 text-xs">
      <summary className="cursor-pointer font-medium">
        Native verification
        {handoff
          ? ` · ${handoff.status === "ready" ? "Awaiting a machine" : handoff.status === "claimed" ? `Claimed by ${handoff.claim?.environmentLabel}` : handoff.status}`
          : " on another machine"}
      </summary>
      <div className="mt-3 space-y-3">
        {!handoff || handoff.status === "canceled" ? (
          <>
            <p>
              Publish this ticket’s committed work to a GitHub checkpoint branch, then verify it
              from a connected environment on the required machine. Independent tickets can
              continue.
            </p>
            <fieldset className="flex flex-wrap gap-3" disabled={busy}>
              <legend className="mb-2">Required platforms</legend>
              {(Object.keys(labels) as NativeVerificationPlatform[]).map((item) => (
                <label key={item} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={platforms.includes(item)}
                    onChange={(event) =>
                      setPlatforms(
                        event.target.checked
                          ? [...platforms, item]
                          : platforms.filter((value) => value !== item),
                      )
                    }
                  />
                  {labels[item]}
                </label>
              ))}
            </fieldset>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || platforms.length === 0}
              onClick={prepare}
            >
              Prepare native handoff
            </Button>
          </>
        ) : (
          <>
            <p>
              Checkpoint <code>{handoff.commitSha.slice(0, 12)}</code>. Required:{" "}
              {handoff.requiredPlatforms.map((item) => labels[item]).join(", ")}.
            </p>
            {handoff.results.map((result) => (
              <p key={`${result.platform}-${result.commitSha}-${result.completedAt}`}>
                {labels[result.platform]}: {result.status}
                {result.commitSha !== handoff.commitSha
                  ? " · Earlier commit, verification required again"
                  : ""}
                . {result.summaryMarkdown}
              </p>
            ))}
            {handoff.status === "ready" ? (
              <>
                <p>
                  Open T3 on your laptop with both the source server and your local environment
                  connected. Clone this repository and add it as a local project first.
                </p>
                <label className="block">
                  Verification environment
                  <select
                    className="mt-1 block w-full rounded border bg-background p-2"
                    value={targetId}
                    disabled={busy}
                    onChange={(event) => {
                      setTargetId(event.target.value);
                      setCapabilities(null);
                      setProjectId("");
                    }}
                  >
                    <option value="">Select environment</option>
                    {environments
                      .filter((item) => item.environmentId !== props.environmentId)
                      .map((item) => (
                        <option key={item.environmentId} value={item.environmentId}>
                          {item.label}
                        </option>
                      ))}
                  </select>
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || !targetId}
                  onClick={() =>
                    act(async () => {
                      const response = await call(EnvironmentId.make(targetId), {
                        operation: "capabilities",
                      });
                      if (response.type === "capabilities") {
                        setCapabilities(response);
                        const first = handoff.requiredPlatforms.find((item) =>
                          response.platforms.includes(item),
                        );
                        if (first) setPlatform(first);
                      }
                    })
                  }
                >
                  Load local projects
                </Button>
                {capabilities ? (
                  <>
                    <p>
                      These targets match the machine’s OS. Install the required SDK, simulator, or
                      application before verification.
                    </p>
                    <label className="block">
                      Local project
                      <select
                        className="mt-1 block w-full rounded border bg-background p-2"
                        value={projectId}
                        disabled={busy}
                        onChange={(event) => setProjectId(event.target.value)}
                      >
                        <option value="">Select repository clone</option>
                        {capabilities.projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block">
                      Platform
                      <select
                        className="mt-1 block w-full rounded border bg-background p-2"
                        value={platform}
                        disabled={busy}
                        onChange={(event) =>
                          setPlatform(event.target.value as NativeVerificationPlatform)
                        }
                      >
                        {handoff.requiredPlatforms
                          .filter((item) => capabilities.platforms.includes(item))
                          .map((item) => (
                            <option key={item} value={item}>
                              {labels[item]}
                            </option>
                          ))}
                      </select>
                    </label>
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        !projectId ||
                        !capabilities.platforms.includes(platform) ||
                        !handoff.requiredPlatforms.includes(platform)
                      }
                      onClick={claim}
                    >
                      Claim and start verification
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
            {handoff.claim ? (
              <>
                <p>
                  The claim stays assigned if the laptop disconnects. Release it before moving
                  verification to another environment.
                </p>
                <a
                  className="underline"
                  href={`/${encodeURIComponent(handoff.claim.environmentId)}/${encodeURIComponent(handoff.claim.threadId)}`}
                >
                  Open verification thread
                </a>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={busy} onClick={submit}>
                    Submit verification results
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      act(async () => {
                        await call(EnvironmentId.make(handoff.claim!.environmentId), {
                          operation: "release-check",
                          handoff,
                        });
                        await call(props.environmentId, {
                          operation: "release",
                          ...target,
                          revision: handoff.revision,
                          claimId: handoff.claim!.id,
                        });
                      })
                    }
                  >
                    Release claim
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    act(() =>
                      call(EnvironmentId.make(handoff.claim!.environmentId), {
                        operation: "checkout",
                        handoff,
                        projectId: handoff.claim!.projectId,
                      }),
                    )
                  }
                >
                  Retry local checkout
                </Button>
              </>
            ) : null}
            {handoff.status === "completed" && props.ticket.status !== "succeeded" ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={prepare}>
                Prepare new checkpoint
              </Button>
            ) : null}
            {handoff.status !== "completed" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || handoff.claim !== null}
                onClick={() =>
                  act(() =>
                    call(props.environmentId, {
                      operation: "cancel",
                      ...target,
                      revision: handoff.revision,
                    }),
                  )
                }
              >
                Cancel handoff
              </Button>
            ) : null}
          </>
        )}
        {busy ? <p role="status">Updating native verification…</p> : null}
        {error ? (
          <p role="alert" className="text-destructive whitespace-pre-wrap">
            {error}
          </p>
        ) : null}
      </div>
    </details>
  );
}
