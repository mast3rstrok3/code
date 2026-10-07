import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import { UserInputRequestedPayload, ApprovalRequestId } from "@t3tools/contracts";
import { randomUUID } from "~/lib/utils";
import { AppReviewWorkflowRunId } from "@t3tools/contracts";
import { useWorkflowCatalog } from "~/workflowCatalogState";
import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandId,
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
import { buildThreadRouteParams } from "~/threadRoutes";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { WorkflowsPanel } from "./WorkflowsPanel";
import { AppReviewPanel } from "./AppReviewPanel";
import { Button } from "./ui/button";
import ChatMarkdown from "./ChatMarkdown";

const questionPayload = Schema.Struct({
  ...UserInputRequestedPayload.fields,
  requestId: Schema.String,
});
const resolvedPayload = Schema.Struct({ requestId: Schema.String });
const decodeQuestionPayload = Schema.decodeUnknownOption(questionPayload);
const decodeResolvedPayload = Schema.decodeUnknownOption(resolvedPayload);

export function WorkflowRuntimePanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const snapshot = useWorkflowSnapshot(threadRef.environmentId);
  const detail = useWorkflowThread(threadRef);
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
  const navigate = useNavigate();
  const [preset, setPreset] = useState<WorkflowPreset>("implementation");
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [document, setDocument] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
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
  const planning = detail.data?.planningWorkflow;
  const send = async (command: ClientOrchestrationCommand) => {
    setBusy(true);
    setError(null);
    try {
      const result = await dispatch({ environmentId: threadRef.environmentId, input: { command } });
      if (result._tag !== "Success")
        setError("The workflow command failed. Check the notification for details.");
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
    const thread = detail.data;
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
  if (snapshot.error || detail.error) return <p role="alert">{snapshot.error ?? detail.error}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex flex-col gap-2 p-3">
        <div className="flex gap-2">
          <select
            aria-label="Workflow"
            value={preset}
            onChange={(event) => setPreset(event.target.value as WorkflowPreset)}
          >
            <option value="implementation">Implementation</option>
            <option value="fast-feature">Fast feature</option>
            <option value="full-feature">Full feature</option>
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
        <Button disabled={busy || !detail.data || !brief.trim()} onClick={() => void launch()}>
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
          <ChatMarkdown text={document} cwd={undefined} />
        </div>
      ) : null}
      {reviewOpen ? (
        <AppReviewPanel
          mode="sidebar"
          threadRef={threadRef}
          launchInFlight={busy}
          launchDisabled={!detail.data}
          sourceSettled={detail.data?.settledOverride === "settled"}
          sourceContext={null}
          previewTargets={[]}
          onOpenThread={openThread}
          onLaunch={(request) => {
            if (!detail.data) return;
            void send({
              type: "thread.app-review-workflow.launch",
              commandId: CommandId.make(randomUUID()),
              targetThreadId: threadRef.threadId,
              controllerThreadId: threadRef.threadId,
              caller: { type: "standalone", sourceThreadId: threadRef.threadId },
              briefMarkdown: request.brief,
              previewTargets: request.reviewUrl ? [request.reviewUrl] : [],
              previewTargetsPinned: Boolean(request.reviewUrl),
              reviewOnly: request.reviewOnly,
              cycleBudget: request.cycleBudget,
              modelSelection: detail.data.modelSelection,
              createdAt: new Date().toISOString(),
            });
          }}
          onStop={(run) =>
            void send({ type: "thread.app-review-workflow.cancel", ...base(), runId: run.id })
          }
        />
      ) : null}
      <WorkflowsPanel
        workflow={workflow}
        activeThreadKey={scopedThreadKey(threadRef)}
        focusedWorkflowId={null}
        timestampFormat="locale"
        implementationRuns={snapshot.data?.implementationRuns ?? []}
        appReviewWorkflowRuns={snapshot.data?.appReviewWorkflowRuns ?? []}
        tickets={planning?.tickets ?? []}
        spec={planning?.spec ?? null}
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
              ? (catalog.catalog.skills.find((skill) => skill.id === id)?.promptText ?? id)
              : id,
          )
        }
        onOpenThread={(thread) => openThread(thread.id)}
        onOpenAppReview={() => setReviewOpen(true)}
        onCopyWorkflowLink={(id) =>
          void navigator.clipboard.writeText(
            `${window.location.href}#workflow=${encodeURIComponent(id)}`,
          )
        }
        onPauseWorkflow={() => void send({ type: "thread.workflow.pause", ...base() })}
        onResumeWorkflow={() => void send({ type: "thread.workflow.resume", ...base() })}
        onRetryImplementationRun={(runId) =>
          void send({ type: "thread.implementation-run.retry", ...base(), runId })
        }
        onRerunImplementationStage={({ runId, target }) =>
          void send({ type: "thread.implementation-run.rerun", ...base(), runId, target })
        }
        onResetImplementationStage={({ runId, target }) =>
          void send({ type: "thread.implementation-run.reset", ...base(), runId, target })
        }
        onSetImplementationSkip={({ runId, target, skipped }) =>
          void send({ type: "thread.implementation-run.skip", ...base(), runId, target, skipped })
        }
        onRerunAppReviewPhase={({ appReviewRunId, phase }) =>
          void send({
            type: "thread.app-review-workflow.rerun",
            ...base(),
            runId: AppReviewWorkflowRunId.make(appReviewRunId),
            phase,
          })
        }
        onRestartPlanningStage={(stage) =>
          void send({ type: "thread.planning-stage.start", ...base(), stage })
        }
        onSetStepModel={(key, modelSelection) =>
          void send({
            type: "thread.workflow.step-model.set",
            ...base(),
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
            ...base(),
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
            ...base(),
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
            void send({ type: "thread.session.stop", ...base(), threadId });
        }}
        onResumeThreads={(ids) => {
          for (const threadId of ids)
            void send({ type: "thread.workflow.resume", ...base(), threadId });
        }}
      />
    </div>
  );
}
