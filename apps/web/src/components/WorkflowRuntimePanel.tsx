import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { UserInputRequestedPayload, ApprovalRequestId } from "@t3tools/contracts";
import { randomUUID } from "~/lib/utils";
import { AppReviewWorkflowRunId } from "@t3tools/contracts";
import { useWorkflowCatalog } from "~/workflowCatalogState";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandId,
  ThreadId,
  WorkflowId,
  MessageId,
  type ClientOrchestrationCommand,
  type ScopedThreadRef,
  type WorkflowPreset,
} from "@t3tools/contracts";
import {
  implementationDefaultsForWorkflowPreset,
  WORKFLOW_PRESET_DEFINITION_BY_ID,
  WORKFLOW_PRESET_DEFINITIONS,
} from "@t3tools/shared/workflowPresets";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { buildWorkflowViewModel, selectWorkflowRootForThread } from "~/workflowModel";
import { useWorkflowSnapshot, useWorkflowThread, workflowEnvironment } from "~/state/workflows";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams, buildWorkflowRouteUrl } from "~/threadRoutes";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { WorkflowsPanel } from "./WorkflowsPanel";
import { AppReviewPanel } from "./AppReviewPanel";
import { Button } from "./ui/button";
import { WorkflowInstructionsPanel } from "./WorkflowInstructionsPanel";
import { useThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useRightPanelStore } from "~/rightPanelStore";
import type { BrowserAppReviewSourceContext } from "./ChatView.logic";

const questionPayload = Schema.Struct({
  ...UserInputRequestedPayload.fields,
  requestId: Schema.String,
});
const resolvedPayload = Schema.Struct({ requestId: Schema.String });
const decodeQuestionPayload = Schema.decodeUnknownOption(questionPayload);
const decodeResolvedPayload = Schema.decodeUnknownOption(resolvedPayload);

export function WorkflowRuntimePanel({
  threadRef,
  initialReviewOpen = false,
  focusedWorkflowId = null,
  sourceSettled,
  sourceContext,
  previewTargets,
}: {
  threadRef: ScopedThreadRef;
  initialReviewOpen?: boolean;
  focusedWorkflowId?: WorkflowId | null;
  sourceSettled: boolean;
  sourceContext: BrowserAppReviewSourceContext | null;
  previewTargets: ReadonlyArray<string>;
}) {
  const snapshot = useWorkflowSnapshot(threadRef.environmentId);
  const detail = useWorkflowThread(threadRef);
  const nativeThread = useThreadShell(threadRef);
  const catalog = useWorkflowCatalog(threadRef.environmentId);
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const pendingQuestions = useMemo(() => {
    const activities = detail.data?.activities ?? [];
    const resolved = new Set(
      activities.flatMap((activity) => {
        if (activity.kind !== "user-input.resolved") return [];
        const payload = decodeResolvedPayload(activity.payload);
        return Option.isSome(payload) ? [payload.value.requestId] : [];
      }),
    );
    return activities.flatMap((activity) => {
      if (activity.kind !== "user-input.requested") return [];
      const decoded = decodeQuestionPayload(activity.payload);
      return Option.isSome(decoded) && !resolved.has(decoded.value.requestId)
        ? [
            {
              requestId: ApprovalRequestId.make(decoded.value.requestId),
              questions: decoded.value.questions,
            },
          ]
        : [];
    });
  }, [detail.data]);
  const dispatch = useAtomCommand(workflowEnvironment.dispatchCommand);
  const canDispatch = useAtomValue(
    workflowEnvironment.dispatchCommand.permissionAtom(threadRef.environmentId),
  );
  const navigate = useNavigate();
  const [preset, setPreset] = useState<WorkflowPreset>("implementation");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [document, setDocument] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(initialReviewOpen);
  const threads = useMemo(
    () =>
      (snapshot.data?.threads ?? []).map((thread) => ({
        ...thread,
        environmentId: threadRef.environmentId,
      })),
    [snapshot.data, threadRef.environmentId],
  );
  const model = useMemo(() => buildWorkflowViewModel(threads), [threads]);
  const workflow = selectWorkflowRootForThread(model, {
    environmentId: threadRef.environmentId,
    id: threadRef.threadId,
  });
  const rootId = workflow?.root.id ?? threadRef.threadId;
  const rootDetail = useWorkflowThread({ ...threadRef, threadId: rootId });
  const artifacts = useEnvironmentQuery(
    rootDetail.data === null
      ? null
      : workflowEnvironment.artifacts({
          environmentId: threadRef.environmentId,
          input: { projectId: rootDetail.data.projectId, threadId: rootId },
        }),
  );
  const refreshArtifacts = artifacts.refresh;
  useEffect(() => {
    refreshArtifacts();
  }, [snapshot.dataUpdatedAt, refreshArtifacts]);
  const planning = rootDetail.data?.planningWorkflow;
  const workflowBase = () => ({ ...base(), threadId: rootId });
  const setConcurrency = (change: {
    maxParallelTickets?: number;
    maxParallelAppReviews?: number;
  }) => {
    const root = workflow?.root;
    if (!root) return;
    void send({
      type: "thread.composer-mode.set",
      ...workflowBase(),
      interactionMode: root.interactionMode,
      workflowPreset: root.workflowPreset ?? null,
      workflowImplementationSettings: {
        ...(root.workflowImplementationSettings ?? settings.implementation),
        ...change,
      },
    });
  };
  const send = async (command: ClientOrchestrationCommand) => {
    if (!canDispatch) return false;
    setBusy(true);
    setError(null);
    try {
      const result = await dispatch({ environmentId: threadRef.environmentId, input: { command } });
      if (result._tag !== "Success")
        setError("The workflow command failed. Check the notification for details.");
      if (result._tag === "Success") detail.refresh();
      return result._tag === "Success";
    } finally {
      setBusy(false);
    }
  };
  const base = () => ({
    commandId: CommandId.make(randomUUID()),
    threadId: threadRef.threadId,
    createdAt: new Date().toISOString(),
  });
  const openThread = (threadId: ScopedThreadRef["threadId"]) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams({ environmentId: threadRef.environmentId, threadId }),
    });
  const launch = async () => {
    const thread = nativeThread ?? detail.data;
    if (!thread || !brief.trim()) return;
    const definition = WORKFLOW_PRESET_DEFINITION_BY_ID[preset];
    if (
      !(await send({
        type: "thread.composer-mode.set",
        ...base(),
        interactionMode: definition.interactionMode,
        workflowPreset: preset,
        workflowImplementationSettings: implementationDefaultsForWorkflowPreset(preset),
      }))
    )
      return;
    await send({
      type: "thread.turn.start",
      ...base(),
      runtimeMode: thread.runtimeMode,
      interactionMode: definition.interactionMode,
      workflowPromptId: definition.workflowPromptId,
      modelSelection: thread.modelSelection,
      message: {
        messageId: MessageId.make(randomUUID()),
        role: "user",
        text: brief,
        attachments: [],
      },
    });
  };
  if (snapshot.error || (detail.error && !nativeThread))
    return <p role="alert">{snapshot.error ?? detail.error}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex gap-2">
          <select
            aria-label="Workflow"
            value={preset}
            onChange={(event) => setPreset(event.target.value as WorkflowPreset)}
          >
            {WORKFLOW_PRESET_DEFINITIONS.map((definition) => (
              <option
                key={definition.id}
                value={definition.id}
                disabled={definition.availability === "under-development"}
              >
                {definition.label}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={() => setReviewOpen((open) => !open)}>
            App Review
          </Button>
        </div>
        <textarea
          aria-label="Workflow brief"
          placeholder="Describe the work or reference ready planning tickets"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
        />
        <Button
          disabled={!canDispatch || busy || (!nativeThread && !detail.data) || !brief.trim()}
          onClick={() => void launch()}
        >
          Start workflow
        </Button>
        {error ? <p role="alert">{error}</p> : null}
      </div>
      {pendingQuestions.map((request) => (
        <form
          key={request.requestId}
          className="space-y-3 p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send({
              type: "thread.user-input.respond",
              ...base(),
              requestId: request.requestId,
              answers: Object.fromEntries(
                request.questions.map((question) => [
                  question.id,
                  {
                    answers: (answers[`${request.requestId}:${question.id}`] ?? []).filter(
                      (answer) => answer.trim(),
                    ),
                  },
                ]),
              ),
            });
          }}
        >
          {request.questions.map((question) => {
            const key = `${request.requestId}:${question.id}`;
            const selected = answers[key] ?? [];
            const optionLabels = new Set(question.options.map((option) => option.label));
            return (
              <fieldset key={question.id} className="flex flex-col gap-2">
                <legend>{question.question}</legend>
                {question.multiSelect ? (
                  question.options.map((option) => (
                    <label key={option.label}>
                      <input
                        type="checkbox"
                        checked={selected.includes(option.label)}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            [key]: event.target.checked
                              ? [...(current[key] ?? []), option.label]
                              : (current[key] ?? []).filter((answer) => answer !== option.label),
                          }))
                        }
                      />
                      {option.label}
                    </label>
                  ))
                ) : question.options.length > 0 ? (
                  <select
                    aria-label={question.header}
                    value={optionLabels.has(selected[0] ?? "") ? selected[0] : ""}
                    onChange={(event) =>
                      setAnswers((current) => ({ ...current, [key]: [event.target.value] }))
                    }
                  >
                    <option value="" disabled>
                      Select an answer
                    </option>
                    {question.options.map((option) => (
                      <option key={option.label} value={option.label}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : null}
                {question.allowCustomAnswer !== false ? (
                  <input
                    aria-label={`${question.header}: your answer`}
                    value={
                      question.multiSelect
                        ? (selected.find((answer) => !optionLabels.has(answer)) ?? "")
                        : (selected[0] ?? "")
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      setAnswers((current) => ({
                        ...current,
                        [key]: [
                          ...(question.multiSelect
                            ? (current[key] ?? []).filter((answer) => optionLabels.has(answer))
                            : []),
                          ...(value ? [value] : []),
                        ],
                      }));
                    }}
                  />
                ) : null}
                {question.recommendation ? (
                  <span>
                    {question.recommendation.optionLabel}: {question.recommendation.rationale}
                  </span>
                ) : null}
              </fieldset>
            );
          })}
          <Button
            type="submit"
            disabled={
              busy ||
              request.questions.some(
                (question) =>
                  !(answers[`${request.requestId}:${question.id}`] ?? []).some((answer) =>
                    answer.trim(),
                  ),
              )
            }
          >
            Submit answers
          </Button>
        </form>
      ))}
      {document !== null ? (
        <div className="p-3">
          <Button variant="outline" size="sm" onClick={() => setDocument(null)}>
            Close document
          </Button>
          <WorkflowInstructionsPanel
            environmentId={threadRef.environmentId}
            workflowPromptId={document}
          />
        </div>
      ) : null}
      {reviewOpen ? (
        <AppReviewPanel
          mode="sidebar"
          threadRef={threadRef}
          launchInFlight={busy}
          launchDisabled={!canDispatch || (!nativeThread && !detail.data)}
          sourceSettled={sourceSettled}
          sourceContext={sourceContext}
          previewTargets={previewTargets}
          workflowArtifacts={artifacts.data}
          onOpenPlanArtifact={() => {
            setReviewOpen(false);
            useRightPanelStore.getState().open(threadRef, "workflows");
          }}
          onOpenThread={openThread}
          onLaunch={(request) => {
            const source = nativeThread ?? detail.data;
            if (!source || !sourceSettled) return;
            void send({
              type: "thread.app-review-workflow.launch",
              commandId: CommandId.make(randomUUID()),
              targetThreadId: threadRef.threadId,
              controllerThreadId: ThreadId.make(randomUUID()),
              caller: { type: "standalone", sourceThreadId: threadRef.threadId },
              briefMarkdown: request.brief,
              supportingContextMarkdown:
                sourceContext?.messages
                  .map((message) => `${message.role}: ${message.text}`)
                  .join("\n\n") ?? null,
              previewTargets: request.reviewUrl ? [request.reviewUrl] : [],
              previewTargetsPinned: Boolean(request.reviewUrl),
              reviewOnly: request.reviewOnly,
              cycleBudget: request.reviewOnly ? 1 : request.cycleBudget,
              modelSelection: source.modelSelection,
              createdAt: new Date().toISOString(),
            });
          }}
          onStop={(run) =>
            void send({
              type: "thread.app-review-workflow.cancel",
              ...base(),
              threadId: run.controllerThreadId,
              runId: run.id,
            })
          }
        />
      ) : null}
      <WorkflowsPanel
        workflow={workflow}
        defaultMaxParallelTickets={settings.implementation.maxParallelTickets}
        defaultMaxParallelAppReviews={settings.implementation.maxParallelAppReviews}
        onSetMaxParallelTickets={
          canDispatch ? (maxParallelTickets) => setConcurrency({ maxParallelTickets }) : undefined
        }
        onSetMaxParallelAppReviews={
          canDispatch
            ? (maxParallelAppReviews) => setConcurrency({ maxParallelAppReviews })
            : undefined
        }
        activeThreadKey={scopedThreadKey(threadRef)}
        focusedWorkflowId={focusedWorkflowId}
        timestampFormat={settings.timestampFormat}
        implementationRuns={
          artifacts.data?.implementationRuns ?? snapshot.data?.implementationRuns ?? []
        }
        appReviewWorkflowRuns={
          artifacts.data?.appReviewWorkflowRuns ?? snapshot.data?.appReviewWorkflowRuns ?? []
        }
        tickets={artifacts.data?.tickets ?? planning?.tickets ?? []}
        spec={artifacts.data?.spec ?? planning?.spec ?? null}
        skillTitlesById={
          new Map(
            catalog.status === "loaded"
              ? catalog.catalog.skills.map((skill) => [skill.id, skill.title])
              : [],
          )
        }
        onOpenSkill={(id) =>
          setDocument(
            catalog.status === "loaded"
              ? (catalog.catalog.skills.find((skill) => skill.id === id)?.promptIds[0] ?? id)
              : id,
          )
        }
        onOpenThread={(thread) => openThread(thread.id)}
        onOpenAppReview={() => setReviewOpen(true)}
        onCopyWorkflowLink={(id) =>
          void navigator.clipboard.writeText(
            buildWorkflowRouteUrl({
              currentHref: window.location.href,
              environmentId: threadRef.environmentId,
              rootThreadId: rootId,
              workflowId: WorkflowId.make(id),
            }),
          )
        }
        onPauseWorkflow={() => void send({ type: "thread.workflow.pause", ...workflowBase() })}
        onResumeWorkflow={() => void send({ type: "thread.workflow.resume", ...workflowBase() })}
        onRetryImplementationRun={(runId) =>
          void send({ type: "thread.implementation-run.retry", ...workflowBase(), runId })
        }
        onRerunImplementationStage={({ runId, target }) =>
          void send({ type: "thread.implementation-run.rerun", ...workflowBase(), runId, target })
        }
        onResetImplementationStage={({ runId, target }) =>
          void send({ type: "thread.implementation-run.reset", ...workflowBase(), runId, target })
        }
        onSetImplementationSkip={({ runId, target, skipped }) =>
          void send({
            type: "thread.implementation-run.skip",
            ...workflowBase(),
            runId,
            target,
            skipped,
          })
        }
        onRerunAppReviewPhase={({ appReviewRunId, phase }) =>
          void send({
            type: "thread.app-review-workflow.rerun",
            ...workflowBase(),
            threadId:
              snapshot.data?.appReviewWorkflowRuns?.find((run) => run.id === appReviewRunId)
                ?.controllerThreadId ?? rootId,
            runId: AppReviewWorkflowRunId.make(appReviewRunId),
            phase,
          })
        }
        onRestartPlanningStage={(stage) =>
          void send({ type: "thread.planning-stage.start", ...workflowBase(), stage })
        }
        onSetStepModel={(key, modelSelection) =>
          void send({
            type: "thread.workflow.step-model.set",
            ...workflowBase(),
            workflowPromptId: key.workflowPromptId,
            ...(key.stepWorkflowPromptId === undefined
              ? {}
              : { stepWorkflowPromptId: key.stepWorkflowPromptId }),
            modelSelection,
          })
        }
        onSetStepCycles={(key, maxCycles) =>
          void send({
            type: "thread.workflow.step-cycles.set",
            ...workflowBase(),
            workflowPromptId: key.workflowPromptId,
            ...(key.stepWorkflowPromptId === undefined
              ? {}
              : { stepWorkflowPromptId: key.stepWorkflowPromptId }),
            maxCycles,
          })
        }
        onSetStepReviewParts={(key, reviewParts) =>
          void send({
            type: "thread.workflow.step-review-parts.set",
            ...workflowBase(),
            workflowPromptId: key.workflowPromptId,
            ...(key.stepWorkflowPromptId === undefined
              ? {}
              : { stepWorkflowPromptId: key.stepWorkflowPromptId }),
            parts: reviewParts,
          })
        }
        defaultStepModels={settings.workflowStepModels}
        defaultStepCycles={settings.workflowStepCycles}
        defaultStepReviewParts={settings.workflowStepReviewParts}
        onStopThreads={(ids) => {
          for (const threadId of ids)
            void send({ type: "thread.session.stop", ...workflowBase(), threadId });
        }}
        onResumeThreads={(ids) => {
          for (const threadId of ids)
            void send({ type: "thread.workflow.resume", ...workflowBase(), threadId });
        }}
      />
    </div>
  );
}
