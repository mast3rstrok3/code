import {
  AlertCircleIcon,
  BookOpenIcon,
  ChevronRightIcon,
  FileTextIcon,
  HammerIcon,
  Loader2Icon,
  SparklesIcon,
  WorkflowIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { type WorkflowCatalogState, useWorkflowCatalog } from "../../workflowCatalogState";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { WorkflowCatalogContent } from "./WorkflowCatalogContent";

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

function CatalogBoundary({ state, noun }: { state: WorkflowCatalogState; noun: string }) {
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
        description="Engineering skills available in Build mode and the guided workflows that use them."
      />
      <CatalogBoundary state={state} noun="Skills" />
      {state.status === "loaded" ? (
        <SettingsSection title="Skill Catalog" icon={<SparklesIcon className="size-3.5" />}>
          {state.catalog.skills
            .toSorted(
              (left, right) =>
                left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
            )
            .map((skill) => (
              <FocusedRow key={skill.id} focused={validFocusedId === skill.id}>
                <SettingsRow
                  title={skill.title}
                  description={skill.description}
                  status={
                    <span className="flex flex-wrap gap-x-3">
                      <span>
                        ID <code className="font-mono">{skill.id}</code>
                      </span>
                    </span>
                  }
                >
                  {skill.buildModes.length > 0 || skill.workflowIds.length > 0 ? (
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 py-2">
                      <span className="mr-1 text-xs text-muted-foreground">Used in</span>
                      {skill.buildModes.map((mode) => (
                        <Badge key={mode} variant="secondary" size="sm">
                          <HammerIcon />
                          Build
                        </Badge>
                      ))}
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
                    <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 py-2">
                      <span className="mr-1 text-xs text-muted-foreground">Docs</span>
                      {skill.docIds.map((docId) => {
                        const doc = state.catalog.docs.find((candidate) => candidate.id === docId);
                        return (
                          <Link key={docId} to="/settings/docs" search={{ doc: docId }}>
                            <Badge variant="outline" size="sm">
                              <FileTextIcon />
                              {doc?.title ?? docId}
                            </Badge>
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
      ) : null}
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
        description="Supporting references organized by the skill that uses them, with summaries and cross-skill links."
      />
      <CatalogBoundary state={state} noun="Docs" />
      {state.status === "loaded"
        ? (() => {
            const skillsById = new Map(state.catalog.skills.map((skill) => [skill.id, skill]));
            const groups = state.catalog.skills
              .map((skill) => ({
                skill,
                docs: state.catalog.docs.filter((doc) => doc.skillIds[0] === skill.id),
              }))
              .filter((group) => group.docs.length > 0)
              .toSorted((left, right) => left.skill.title.localeCompare(right.skill.title));
            return groups.length === 0 ? (
              <SettingsSection
                title="Document Catalog"
                icon={<BookOpenIcon className="size-3.5" />}
              >
                <SettingsRow
                  title="No docs"
                  description="No supporting workflow documents are registered."
                />
              </SettingsSection>
            ) : (
              groups.map(({ skill, docs }) => (
                <SettingsSection
                  key={skill.id}
                  title={skill.title}
                  icon={<BookOpenIcon className="size-3.5" />}
                >
                  {docs.map((doc) => (
                    <FocusedRow key={doc.id} focused={validFocusedId === doc.id}>
                      <SettingsRow
                        title={doc.title}
                        description={doc.description}
                        status={doc.path}
                      >
                        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 py-2">
                          <span className="mr-1 text-xs text-muted-foreground">Used by</span>
                          {doc.skillIds.map((skillId) => (
                            <Link key={skillId} to="/settings/skills" search={{ skill: skillId }}>
                              <Badge variant="secondary" size="sm">
                                <SparklesIcon />
                                {skillsById.get(skillId)?.title ?? skillId}
                              </Badge>
                            </Link>
                          ))}
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
                  ))}
                </SettingsSection>
              ))
            );
          })()
        : null}
    </SettingsPageContainer>
  );
}
