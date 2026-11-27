import type { BundledSkill, EnvironmentId } from "@t3tools/contracts";
import {
  AlertCircleIcon,
  BookOpenIcon,
  ChevronRightIcon,
  FileTextIcon,
  Loader2Icon,
  PuzzleIcon,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { type SkillCatalogState, useSkillCatalog } from "../../skillCatalogState";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Badge } from "../ui/badge";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SkillContent } from "./SkillContent";
import { SkillMarkdown } from "./SkillMarkdown";

function PageIntro({ title, description }: { title: string; description: React.ReactNode }) {
  return (
    <div className="space-y-1 px-1">
      <h1 className="text-lg font-semibold text-foreground">{title}</h1>
      <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function CatalogBoundary({ state, noun }: { state: SkillCatalogState; noun: string }) {
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
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the DOM row into view when focused
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  return (
    <div ref={ref} className={focused ? "rounded-xl ring-1 ring-primary/50" : undefined}>
      {children}
    </div>
  );
}

export function resolveCatalogFocusId(
  requestedId: string | undefined,
  availableIds: readonly string[],
): string | undefined {
  return requestedId !== undefined && availableIds.includes(requestedId) ? requestedId : undefined;
}

function SkillInstructions({
  skill,
  environmentId,
  focused,
}: {
  skill: BundledSkill;
  environmentId: EnvironmentId | null;
  focused: boolean;
}) {
  const [expanded, setExpanded] = useState(focused);
  return (
    <details
      open={focused}
      onToggle={(event) => setExpanded(event.currentTarget.open)}
      className="group border-t border-border/60"
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 py-2 font-medium text-muted-foreground text-xs">
        <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
        Skill instructions
      </summary>
      {expanded ? <SkillContent skill={skill} environmentId={environmentId} /> : null}
    </details>
  );
}

export function SkillSettings({ focusedSkillId }: { focusedSkillId: string | undefined }) {
  const environmentId = usePrimaryEnvironmentId();
  const state = useSkillCatalog();
  const validFocusedId =
    state.status === "loaded"
      ? resolveCatalogFocusId(
          focusedSkillId,
          state.catalog.skills.map((skill) => skill.name),
        )
      : undefined;
  return (
    <SettingsPageContainer>
      <PageIntro
        title="Skills"
        description="Skills T3 Code ships to every Claude session. Run one with /t3:<name> or a $t3:<name> mention."
      />
      <CatalogBoundary state={state} noun="Skills" />
      {state.status === "loaded" ? (
        <SettingsSection title="Skill Catalog" icon={<PuzzleIcon className="size-3.5" />}>
          {state.catalog.skills.map((skill) => (
            <FocusedRow key={skill.name} focused={validFocusedId === skill.name}>
              <SettingsRow
                title={skill.name}
                description={skill.description}
                status={
                  <span className="flex flex-wrap items-center gap-x-3">
                    <code className="font-mono">{`/${state.catalog.pluginName}:${skill.name}`}</code>
                    {skill.userInvocationOnly ? <span>Runs only when you invoke it</span> : null}
                  </span>
                }
              >
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
                <SkillInstructions
                  skill={skill}
                  environmentId={environmentId}
                  focused={validFocusedId === skill.name}
                />
              </SettingsRow>
            </FocusedRow>
          ))}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}

export function DocSettings({ focusedDocId }: { focusedDocId: string | undefined }) {
  const state = useSkillCatalog();
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
        description="Supporting files the bundled skills read when they need them, grouped by skill."
      />
      <CatalogBoundary state={state} noun="Docs" />
      {state.status === "loaded"
        ? state.catalog.skills
            .map((skill) => ({
              skill,
              docs: state.catalog.docs.filter((doc) => doc.skill === skill.name),
            }))
            .filter((group) => group.docs.length > 0)
            .map(({ skill, docs }) => (
              <SettingsSection
                key={skill.name}
                title={skill.name}
                icon={<BookOpenIcon className="size-3.5" />}
              >
                {docs.map((doc) => (
                  <FocusedRow key={doc.id} focused={validFocusedId === doc.id}>
                    <SettingsRow title={doc.title} description={doc.description} status={doc.path}>
                      <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 py-2">
                        <span className="mr-1 text-xs text-muted-foreground">Part of</span>
                        <Link to="/settings/skills" search={{ skill: skill.name }}>
                          <Badge variant="secondary" size="sm">
                            <PuzzleIcon />
                            {skill.name}
                          </Badge>
                        </Link>
                      </div>
                      <details
                        open={validFocusedId === doc.id}
                        className="group mt-3 border-t border-border/60"
                      >
                        <summary className="flex cursor-pointer list-none items-center gap-2 py-2 font-medium text-muted-foreground text-xs">
                          <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
                          Document content
                        </summary>
                        <SkillMarkdown
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
        : null}
    </SettingsPageContainer>
  );
}
