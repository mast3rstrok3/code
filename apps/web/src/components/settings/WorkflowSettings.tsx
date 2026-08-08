import {
  AlertCircleIcon,
  BookOpenIcon,
  ChevronRightIcon,
  FileTextIcon,
  Loader2Icon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import type { WorkflowCatalog } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { WorkflowCatalogContent } from "./WorkflowCatalogContent";

type CatalogState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly catalog: WorkflowCatalog }
  | { readonly status: "error"; readonly message: string };

function useWorkflowCatalog(): CatalogState {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.workflowCatalog({ environmentId, input: {} }),
  );
  if (environmentId === null) {
    return { status: "error", message: "No primary server environment is connected." };
  }
  if (query.error !== null) return { status: "error", message: query.error };
  if (query.data !== null) return { status: "loaded", catalog: query.data };
  return { status: "loading" };
}

function PageIntro({ title, description }: { title: string; description: string }) {
  return (
    <div className="space-y-3">
      <div className="space-y-1 px-1">
        <h1 className="text-lg font-semibold text-foreground tracking-[-0.01em]">{title}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-1">
        <Badge variant="secondary" size="sm">
          Read-only
        </Badge>
        <Badge variant="secondary" size="sm">
          Repository versioned
        </Badge>
        <Badge variant="secondary" size="sm">
          Codex + Claude
        </Badge>
      </div>
    </div>
  );
}

function CatalogBoundary({ state, noun }: { state: CatalogState; noun: string }) {
  if (state.status === "loaded") return null;
  return (
    <SettingsSection title={noun}>
      <SettingsRow
        title={
          state.status === "loading" ? (
            <span className="inline-flex items-center gap-2">
              <Loader2Icon className="size-3.5 animate-spin" />
              Loading
            </span>
          ) : (
            <span className="inline-flex items-center gap-2">
              <AlertCircleIcon className="size-3.5 text-destructive" />
              Could not load {noun.toLowerCase()}
            </span>
          )
        }
        description={
          state.status === "loading"
            ? `Fetching ${noun.toLowerCase()} from the server.`
            : state.message
        }
      />
    </SettingsSection>
  );
}

function FocusedRow({ focused, children }: { focused: boolean; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  return (
    <div ref={ref} className={focused ? "rounded-xl ring-1 ring-primary/50" : undefined}>
      {children}
    </div>
  );
}

export function WorkflowSettings() {
  const state = useWorkflowCatalog();
  return (
    <SettingsPageContainer>
      <PageIntro
        title="Workflows"
        description="Built-in orchestration paths and the skills each step uses."
      />
      <CatalogBoundary state={state} noun="Workflows" />
      {state.status === "loaded" ? (
        <SettingsSection title="Workflow Catalog" icon={<WorkflowIcon className="size-3.5" />}>
          {state.catalog.workflows.length === 0 ? (
            <SettingsRow title="No workflows" description="No built-in workflows are registered." />
          ) : (
            state.catalog.workflows.map((workflow) => (
              <SettingsRow
                key={workflow.id}
                title={workflow.title}
                description={workflow.description}
                status={<code className="font-mono">{workflow.interactionMode}</code>}
              >
                <ol className="mt-3 space-y-2 border-t border-border/60 py-3">
                  {workflow.steps.map((step, index) => (
                    <li key={`${workflow.id}-${step.label}`} className="flex gap-3 text-xs">
                      <span className="text-muted-foreground">{index + 1}.</span>
                      <div className="min-w-0">
                        {step.skillId ? (
                          <Link
                            to="/settings/skills"
                            search={{ skill: step.skillId }}
                            className="font-medium text-foreground hover:underline"
                          >
                            {step.label}
                          </Link>
                        ) : (
                          <span className="font-medium">{step.label}</span>
                        )}
                        {step.threadBoundary || step.note ? (
                          <div className="mt-0.5 text-muted-foreground">
                            {[step.threadBoundary, step.note].filter(Boolean).join(" · ")}
                          </div>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </SettingsRow>
            ))
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

const GROUP_TITLES = {
  shared: "Shared",
  product: "Product Intent",
  planning: "Planning",
  implementation: "Implementation",
} as const;

export function resolveCatalogFocusId(
  requestedId: string | undefined,
  availableIds: readonly string[],
): string | undefined {
  return requestedId !== undefined && availableIds.includes(requestedId) ? requestedId : undefined;
}

export function SkillSettings({ focusedSkillId }: { focusedSkillId: string | undefined }) {
  const state = useWorkflowCatalog();
  const validFocusedId =
    state.status === "loaded"
      ? resolveCatalogFocusId(
          focusedSkillId,
          state.catalog.skills.map((skill) => skill.id),
        )
      : undefined;
  return (
    <SettingsPageContainer>
      <PageIntro
        title="Skills"
        description="Focused instructions loaded when a workflow runs a particular step."
      />
      <CatalogBoundary state={state} noun="Skills" />
      {state.status === "loaded"
        ? (Object.keys(GROUP_TITLES) as Array<keyof typeof GROUP_TITLES>).map((group) => {
            const skills = state.catalog.skills
              .filter((skill) => skill.workflow === group)
              .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id));
            return skills.length === 0 ? null : (
              <SettingsSection
                key={group}
                title={GROUP_TITLES[group]}
                icon={<SparklesIcon className="size-3.5" />}
              >
                {skills.map((skill) => (
                  <FocusedRow key={skill.id} focused={validFocusedId === skill.id}>
                    <SettingsRow
                      title={skill.title}
                      description={skill.description}
                      status={
                        <span className="flex flex-wrap gap-x-3">
                          <span>
                            Role <code className="font-mono">{skill.role}</code>
                          </span>
                          <span>
                            Stage <code className="font-mono">{skill.stage}</code>
                          </span>
                          <span>
                            ID <code className="font-mono">{skill.id}</code>
                          </span>
                        </span>
                      }
                    >
                      {skill.workflowIds.length > 0 ? (
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 py-2">
                          <span className="mr-1 text-xs text-muted-foreground">Used in</span>
                          {skill.workflowIds.map((workflowId) => {
                            const workflow = state.catalog.workflows.find(
                              (candidate) => candidate.id === workflowId,
                            );
                            return (
                              <Badge key={workflowId} variant="secondary" size="sm">
                                <WorkflowIcon />
                                {workflow?.title ?? workflowId}
                              </Badge>
                            );
                          })}
                        </div>
                      ) : null}
                      {skill.docIds.length > 0 ? (
                        <div className="flex flex-wrap gap-2 border-t border-border/60 py-2">
                          {skill.docIds.map((docId) => {
                            const doc = state.catalog.docs.find(
                              (candidate) => candidate.id === docId,
                            );
                            return (
                              <Link
                                key={docId}
                                to="/settings/docs"
                                search={{ doc: docId }}
                                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                              >
                                <FileTextIcon className="size-3" />
                                {doc?.title ?? docId}
                              </Link>
                            );
                          })}
                        </div>
                      ) : null}
                      <details
                        open={validFocusedId === skill.id}
                        className="group border-t border-border/60"
                      >
                        <summary className="flex cursor-pointer list-none items-center gap-2 py-2 font-medium text-muted-foreground text-xs">
                          <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                          Prompt text
                        </summary>
                        <WorkflowCatalogContent
                          text={skill.promptText}
                          label={`${skill.title} prompt text`}
                          maxHeightClassName="max-h-[26rem]"
                        />
                      </details>
                    </SettingsRow>
                  </FocusedRow>
                ))}
              </SettingsSection>
            );
          })
        : null}
    </SettingsPageContainer>
  );
}

export function DocSettings({ focusedDocId }: { focusedDocId: string | undefined }) {
  const state = useWorkflowCatalog();
  const validFocusedId =
    state.status === "loaded"
      ? resolveCatalogFocusId(
          focusedDocId,
          state.catalog.docs.map((doc) => doc.id),
        )
      : undefined;
  return (
    <SettingsPageContainer>
      <PageIntro
        title="Docs"
        description="Supporting references that workflow skills load only when they need the additional context."
      />
      <CatalogBoundary state={state} noun="Docs" />
      {state.status === "loaded" ? (
        <SettingsSection title="Document Catalog" icon={<BookOpenIcon className="size-3.5" />}>
          {state.catalog.docs.length === 0 ? (
            <SettingsRow
              title="No docs"
              description="No supporting workflow documents are registered."
            />
          ) : (
            state.catalog.docs.map((doc) => (
              <FocusedRow key={doc.id} focused={validFocusedId === doc.id}>
                <SettingsRow
                  title={doc.title}
                  description={doc.path}
                  status={
                    <span>
                      ID <code className="font-mono">{doc.id}</code>
                    </span>
                  }
                >
                  <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 py-2">
                    <span className="mr-1 text-xs text-muted-foreground">Used by</span>
                    {doc.skillIds.map((skillId) => {
                      const skill = state.catalog.skills.find(
                        (candidate) => candidate.id === skillId,
                      );
                      return (
                        <Link key={skillId} to="/settings/skills" search={{ skill: skillId }}>
                          <Badge variant="secondary" size="sm">
                            <SparklesIcon />
                            {skill?.title ?? skillId}
                          </Badge>
                        </Link>
                      );
                    })}
                  </div>
                  <details
                    open={validFocusedId === doc.id}
                    className="group mt-3 border-t border-border/60"
                  >
                    <summary className="flex cursor-pointer list-none items-center gap-2 py-2 font-medium text-muted-foreground text-xs">
                      <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                      Document content
                    </summary>
                    <WorkflowCatalogContent
                      text={doc.content}
                      label={`${doc.title} document content`}
                      maxHeightClassName="max-h-[28rem]"
                    />
                  </details>
                </SettingsRow>
              </FocusedRow>
            ))
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
