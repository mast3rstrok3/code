import type {
  OrchestrationV2TurnItem,
  WizardTranscriptItem,
  WizardTranscriptKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

// Long outputs keep their tail (commands) or head (patches); the owner sees the rest in Code.
const OUTPUT_MAX_CHARS = 20_000;
const PATCH_MAX_CHARS = 50_000;
const TOOL_TEXT_MAX_CHARS = 10_000;

export type TranscriptEntry = Omit<WizardTranscriptItem, "seq">;

const head = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
const tail = (text: string, max: number) =>
  text.length <= max ? text : `… (${text.length - max} earlier characters)\n${text.slice(-max)}`;

const asText = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const isRunning = (item: OrchestrationV2TurnItem) =>
  item.status === "running" || item.status === "pending" || item.status === "waiting";

const toolStatus = (item: OrchestrationV2TurnItem): "running" | "done" | "failed" =>
  isRunning(item)
    ? "running"
    : item.status === "failed" || item.status === "interrupted" || item.status === "cancelled"
      ? "failed"
      : "done";

/**
 * The transcript entry a turn item shows as, or null for items a Wizard does not need
 * (checkpoints, compactions, handoffs, forks and the like).
 */
export function transcriptEntry(item: OrchestrationV2TurnItem): TranscriptEntry | null {
  const base = (kind: WizardTranscriptKind) => ({
    id: item.id,
    kind,
    createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
  });
  const final = !isRunning(item);
  const tool = (name: string, input?: unknown, output?: unknown): TranscriptEntry => {
    const inputText = asText(input);
    const outputText = asText(output);
    return {
      ...base("tool"),
      tool: {
        name,
        ...(inputText === undefined ? {} : { input: head(inputText, TOOL_TEXT_MAX_CHARS) }),
        ...(outputText === undefined ? {} : { output: tail(outputText, TOOL_TEXT_MAX_CHARS) }),
        status: toolStatus(item),
      },
      final,
    };
  };
  switch (item.type) {
    case "user_message":
      return { ...base("user"), text: item.text, final: true };
    case "assistant_message":
      return { ...base("assistant"), text: item.text, final: !item.streaming };
    case "reasoning":
      return { ...base("reasoning"), text: item.text, final: !item.streaming };
    case "proposed_plan":
      return { ...base("assistant"), text: item.markdown, final: !item.streaming };
    case "todo_list":
      return {
        ...base("status"),
        text: item.steps
          .map((step) => `- [${step.status === "completed" ? "x" : " "}] ${step.text}`)
          .join("\n"),
        final,
      };
    case "command_execution":
      return {
        ...base("command"),
        command: {
          command: item.input,
          ...(item.output === undefined ? {} : { output: tail(item.output, OUTPUT_MAX_CHARS) }),
          exitCode: item.exitCode ?? null,
        },
        final,
      };
    case "file_change":
      return {
        ...base("diff"),
        diff: {
          files: [
            { path: item.fileName, additions: item.additions ?? 0, deletions: item.deletions ?? 0 },
          ],
          ...(item.diffStr === undefined ? {} : { patch: head(item.diffStr, PATCH_MAX_CHARS) }),
        },
        final,
      };
    case "file_search":
      return tool("file_search", item.pattern, item.results);
    case "web_search":
      return tool("web_search", item.patterns, item.results);
    case "dynamic_tool":
      return tool(item.toolName ?? item.title ?? "tool", item.input, item.output);
    case "subagent":
      return tool("subagent", item.prompt, item.result ?? item.progress);
    case "approval_request":
      return {
        ...base("status"),
        text: `Waiting for the owner to approve: ${item.prompt ?? item.reason ?? item.requestKind}`,
        final,
      };
    case "user_input_request":
      return {
        ...base("status"),
        text: item.questions.map((question) => question.question).join("\n"),
        final,
      };
    case "secret_request":
      return { ...base("status"), text: `Waiting for the owner: ${item.label}`, final };
    case "link_request":
      return { ...base("status"), text: "Waiting for the owner to link an environment.", final };
    case "run_interrupt_request":
    case "run_interrupt_result":
      return { ...base("status"), text: item.message, final };
    case "system_notice":
      return {
        ...base(item.level === "error" ? "error" : "status"),
        text: item.message,
        final,
      };
    case "error":
      return { ...base("error"), text: item.failure.message, final: true };
    default:
      return null;
  }
}

interface Assigned {
  readonly fingerprint: string;
  readonly seq: number;
}

/**
 * Gives every transcript entry a `seq` that rises each time its content changes. Seqs live in
 * memory and start from the clock in microseconds, so after a restart every entry comes once
 * more with a higher seq; callers keep entries by id, so that only repeats them.
 */
export class TranscriptSequencer {
  private last = 0;
  private readonly threads = new Map<string, Map<string, Assigned>>();

  private readonly nowMillis: () => number;

  constructor(nowMillis: () => number = Date.now) {
    this.nowMillis = nowMillis;
  }

  /** Every entry of the thread with its seq, in seq order. Entries must be in timeline order. */
  assign(threadId: string, entries: ReadonlyArray<TranscriptEntry>): WizardTranscriptItem[] {
    let assigned = this.threads.get(threadId);
    if (assigned === undefined) {
      assigned = new Map();
      this.threads.set(threadId, assigned);
    }
    const items: WizardTranscriptItem[] = [];
    for (const entry of entries) {
      const fingerprint = JSON.stringify(entry);
      let current = assigned.get(entry.id);
      if (current === undefined || current.fingerprint !== fingerprint) {
        this.last = Math.max(this.last + 1, this.nowMillis() * 1000);
        current = { fingerprint, seq: this.last };
        assigned.set(entry.id, current);
      }
      items.push({ ...entry, seq: current.seq });
    }
    return items.toSorted((left, right) => left.seq - right.seq);
  }
}

/** The items after `after`, and the cursor to pass next time. */
export function transcriptPage(items: ReadonlyArray<WizardTranscriptItem>, after: number) {
  const newer = items.filter((item) => item.seq > after);
  const cursor = items.reduce((max, item) => Math.max(max, item.seq), after);
  return { items: newer, cursor };
}
