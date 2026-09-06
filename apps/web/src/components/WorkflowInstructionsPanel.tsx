import type { EnvironmentId } from "@t3tools/contracts";
import { BookOpenText } from "lucide-react";

import { useWorkflowCatalog } from "../workflowCatalogState";
import { WorkflowSkillContent } from "./WorkflowSkillContent";
import { WorkflowCatalogContent } from "./settings/WorkflowCatalogContent";

export function WorkflowInstructionsPanel({
  environmentId,
  workflowPromptId,
}: {
  environmentId: EnvironmentId;
  workflowPromptId: string;
}) {
  const state = useWorkflowCatalog(environmentId);
  if (state.status === "loading") {
    return <div className="p-4 text-sm text-muted-foreground">Loading instructions…</div>;
  }
  if (state.status === "error") {
    return <div className="p-4 text-sm text-destructive">{state.message}</div>;
  }

  const skill = state.catalog.skills.find((entry) => entry.promptIds.includes(workflowPromptId));
  if (!skill) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No catalog entry is available for <code>{workflowPromptId}</code>.
      </div>
    );
  }
  const docs = state.catalog.docs.filter((doc) => skill.docIds.includes(doc.id));

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mx-auto max-w-3xl">
        <div className="mb-4 flex items-start gap-3">
          <BookOpenText className="mt-0.5 size-5 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="font-medium text-sm">{skill.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">{skill.description}</p>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
              <code className="rounded bg-muted px-1.5 py-0.5">{skill.id}</code>
              <code className="rounded bg-muted px-1.5 py-0.5">{workflowPromptId}</code>
            </div>
          </div>
        </div>
        <WorkflowSkillContent
          skill={skill}
          environmentId={environmentId}
          workflowPromptId={workflowPromptId}
        />
        {docs.map((doc) => (
          <details key={doc.id} className="mb-3 rounded-lg border border-border/70 px-3 py-2">
            <summary className="cursor-pointer text-xs font-medium">{doc.title}</summary>
            <div className="pt-3">
              <WorkflowCatalogContent
                text={doc.content}
                label={`${doc.title} supporting instructions`}
                maxHeightClassName="max-h-none"
              />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
