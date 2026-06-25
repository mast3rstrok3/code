import {
  AlertCircleIcon,
  ChevronRightIcon,
  FileTextIcon,
  Loader2Icon,
  WorkflowIcon,
} from "lucide-react";
import type { WorkflowPromptContract } from "@t3tools/contracts";
import { useMemo } from "react";

import { usePrimarySettings, useUpdatePrimarySettings } from "../../hooks/useSettings";
import { usePrimaryEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

type PromptLoadState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly contracts: readonly WorkflowPromptContract[] }
  | { readonly status: "error"; readonly message: string };

function workflowTitle(workflow: WorkflowPromptContract["workflow"]): string {
  switch (workflow) {
    case "shared":
      return "Shared Workflow Prompt";
    case "planning":
      return "Planning Workflow";
    case "implementation":
      return "Implementation Workflow";
    case "yolo":
      return "YOLO Workflow";
  }
}

function WorkflowStatusRow() {
  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <Badge variant="secondary" size="sm">
        Read-only
      </Badge>
      <Badge variant="secondary" size="sm">
        Repository versioned
      </Badge>
      <Badge variant="secondary" size="sm">
        Codex + Claude in v1
      </Badge>
    </div>
  );
}

function PromptContractRow({ contract }: { contract: WorkflowPromptContract }) {
  return (
    <SettingsRow
      title={contract.title}
      description={contract.description}
      status={
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          <span>
            Role <code className="font-mono text-foreground/80">{contract.role}</code>
          </span>
          <span>
            Stage <code className="font-mono text-foreground/80">{contract.stage}</code>
          </span>
          <span>
            Contract <code className="font-mono text-foreground/80">{contract.id}</code>
          </span>
        </span>
      }
    >
      <details className="group mt-3 border-t border-border/60">
        <summary className="flex cursor-pointer list-none items-center gap-2 py-2 font-medium text-muted-foreground text-xs hover:text-foreground">
          <ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />
          Prompt text
        </summary>
        <pre className="mb-4 max-h-[26rem] overflow-auto rounded-lg border border-border/70 bg-muted/35 p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/85">
          <code className="font-mono">{contract.promptText}</code>
        </pre>
      </details>
      {contract.associatedDocs !== undefined && contract.associatedDocs.length > 0 ? (
        <div className="mb-3 border-t border-border/60 pt-2">
          <div className="mb-1.5 flex items-center gap-2 font-medium text-muted-foreground text-xs">
            <FileTextIcon className="size-3.5" />
            Associated docs
          </div>
          <div className="space-y-1.5">
            {contract.associatedDocs.map((doc) => (
              <details
                key={doc.id}
                className="group rounded-md border border-border/70 bg-muted/20"
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 font-medium text-muted-foreground text-xs hover:text-foreground">
                  <span className="flex min-w-0 items-center gap-2">
                    <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
                    <span className="truncate">{doc.title}</span>
                  </span>
                  <code className="shrink-0 font-mono text-[11px] text-foreground/70">
                    {doc.path}
                  </code>
                </summary>
                <pre className="max-h-[22rem] overflow-auto border-t border-border/60 bg-muted/35 p-3 text-[11px] leading-relaxed whitespace-pre-wrap text-foreground/85">
                  <code className="font-mono">{doc.content}</code>
                </pre>
              </details>
            ))}
          </div>
        </div>
      ) : null}
    </SettingsRow>
  );
}

function WorkflowPromptSection({
  title,
  contracts,
}: {
  title: string;
  contracts: readonly WorkflowPromptContract[];
}) {
  return (
    <SettingsSection title={title} icon={<WorkflowIcon className="size-3.5" />}>
      {contracts.length === 0 ? (
        <SettingsRow
          title="No prompt contracts"
          description="No prompt contracts are registered."
        />
      ) : (
        contracts.map((contract) => <PromptContractRow key={contract.id} contract={contract} />)
      )}
    </SettingsSection>
  );
}

function ImplementationWorkflowSettingsSection() {
  const autoStartAppDevStack = usePrimarySettings(
    (settings) => settings.implementation.autoStartAppDevStack,
  );
  const updateSettings = useUpdatePrimarySettings();

  return (
    <SettingsSection title="Implementation Workflow" icon={<WorkflowIcon className="size-3.5" />}>
      <SettingsRow
        title="Auto-start app-dev stack"
        description="Start the orchestrator worktree app-dev stack automatically when an Implementation Workflow run launches."
        status="Browser QA still blocks completion if the stack or Chrome tooling is unavailable."
        control={
          <Switch
            checked={autoStartAppDevStack}
            onCheckedChange={(checked) =>
              updateSettings({
                implementation: {
                  autoStartAppDevStack: Boolean(checked),
                },
              })
            }
            aria-label="Auto-start app-dev stack for Implementation Workflow"
          />
        }
      />
    </SettingsSection>
  );
}

export function WorkflowSettings() {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const promptsQuery = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.workflowPrompts({
          environmentId,
          input: {},
        }),
  );
  const state: PromptLoadState =
    environmentId === null
      ? {
          status: "error",
          message: "No primary server environment is connected.",
        }
      : promptsQuery.error !== null
        ? {
            status: "error",
            message: promptsQuery.error,
          }
        : promptsQuery.data !== null
          ? { status: "loaded", contracts: promptsQuery.data }
          : { status: "loading" };

  const grouped = useMemo(() => {
    const contracts = state.status === "loaded" ? state.contracts : [];
    return {
      shared: contracts
        .filter((contract) => contract.workflow === "shared")
        .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
      planning: contracts
        .filter((contract) => contract.workflow === "planning")
        .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
      implementation: contracts
        .filter((contract) => contract.workflow === "implementation")
        .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
      yolo: contracts
        .filter((contract) => contract.workflow === "yolo")
        .toSorted((left, right) => left.order - right.order || left.id.localeCompare(right.id)),
    };
  }, [state]);

  return (
    <SettingsPageContainer>
      <div className="space-y-3">
        <div className="space-y-1 px-1">
          <h1 className="text-lg font-semibold text-foreground tracking-[-0.01em]">Workflow</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Workflow prompt contracts are served from the server registry used by workflow modes.
          </p>
        </div>
        <WorkflowStatusRow />
      </div>

      <ImplementationWorkflowSettingsSection />

      {state.status === "loading" ? (
        <SettingsSection title="Workflow Prompts">
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <Loader2Icon className="size-3.5 animate-spin" />
                Loading
              </span>
            }
            description="Fetching workflow prompt contracts from the server."
          />
        </SettingsSection>
      ) : null}

      {state.status === "error" ? (
        <SettingsSection title="Workflow Prompts">
          <SettingsRow
            title={
              <span className="inline-flex items-center gap-2">
                <AlertCircleIcon className="size-3.5 text-destructive" />
                Could not load workflow prompts
              </span>
            }
            description={state.message}
          />
        </SettingsSection>
      ) : null}

      {state.status === "loaded" ? (
        <>
          <WorkflowPromptSection title={workflowTitle("shared")} contracts={grouped.shared} />
          <WorkflowPromptSection title={workflowTitle("planning")} contracts={grouped.planning} />
          <WorkflowPromptSection
            title={workflowTitle("implementation")}
            contracts={grouped.implementation}
          />
          <WorkflowPromptSection title={workflowTitle("yolo")} contracts={grouped.yolo} />
        </>
      ) : null}
    </SettingsPageContainer>
  );
}
