import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProjectionThreadMessageRepository } from "../Services/ProjectionThreadMessages.ts";
import { ProjectionThreadMessageRepositoryLive } from "./ProjectionThreadMessages.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  ProjectionThreadMessageRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ProjectionThreadMessageRepository", (it) => {
  it.effect("finds the latest user-message time within one thread", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-latest-user-message");
      assert.isNull(yield* repository.getLatestUserMessageAt({ threadId }));

      const messages = [
        { role: "user", createdAt: "2026-02-28T19:05:02.000Z" },
        { role: "user", createdAt: "2026-02-28T19:05:01.000Z" },
        { role: "assistant", createdAt: "2026-02-28T19:05:03.000Z" },
        { role: "system", createdAt: "2026-02-28T19:05:04.000Z" },
      ] as const;
      for (const [index, message] of messages.entries()) {
        yield* repository.upsert({
          messageId: MessageId.make(`latest-user-message-${index}`),
          threadId,
          turnId: null,
          workflowPromptId: null,
          ...message,
          text: "Message body",
          isStreaming: false,
          updatedAt: "2026-02-28T19:06:00.000Z",
        });
      }
      yield* repository.upsert({
        messageId: MessageId.make("latest-user-message-other-thread"),
        threadId: ThreadId.make("thread-latest-user-message-other"),
        turnId: null,
        workflowPromptId: null,
        role: "user",
        text: "Other thread",
        isStreaming: false,
        createdAt: "2026-02-28T19:05:05.000Z",
        updatedAt: "2026-02-28T19:05:05.000Z",
      });

      assert.strictEqual(
        yield* repository.getLatestUserMessageAt({ threadId }),
        "2026-02-28T19:05:02.000Z",
      );
      yield* repository.deleteByThreadId({ threadId });
      assert.isNull(yield* repository.getLatestUserMessageAt({ threadId }));
    }),
  );

  it.effect("preserves an associated workflow prompt across message updates", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const messageId = MessageId.make("message-workflow-prompt");
      const threadId = ThreadId.make("thread-workflow-prompt");
      const base = {
        messageId,
        threadId,
        turnId: null,
        workflowPromptId: null,
        role: "user" as const,
        text: "Plan this",
        isStreaming: false,
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      };
      yield* repository.upsert({ ...base, workflowPromptId: "planning.spec.codex" });
      yield* repository.upsert({ ...base, text: "Plan this feature", workflowPromptId: null });

      const row = yield* repository.getByMessageId({ messageId });
      assert.equal(row._tag === "Some" ? row.value.workflowPromptId : null, "planning.spec.codex");
    }),
  );

  it.effect("preserves existing attachments when upsert omits attachments", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-preserve-attachments");
      const messageId = MessageId.make("message-preserve-attachments");
      const createdAt = "2026-02-28T19:00:00.000Z";
      const updatedAt = "2026-02-28T19:00:01.000Z";
      const persistedAttachments = [
        {
          type: "image" as const,
          id: "thread-preserve-attachments-att-1",
          name: "example.png",
          mimeType: "image/png",
          sizeBytes: 5,
        },
      ];

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        workflowPromptId: null,
        text: "initial",
        attachments: persistedAttachments,
        isStreaming: false,
        createdAt,
        updatedAt,
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "user",
        workflowPromptId: null,
        text: "updated",
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:00:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "updated");
      assert.deepEqual(rows[0]?.attachments, persistedAttachments);

      const rowById = yield* repository.getByMessageId({ messageId });
      assert.equal(rowById._tag, "Some");
      if (rowById._tag === "Some") {
        assert.equal(rowById.value.text, "updated");
        assert.deepEqual(rowById.value.attachments, persistedAttachments);
      }
    }),
  );

  it.effect("allows explicit attachment clearing with an empty array", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadMessageRepository;
      const threadId = ThreadId.make("thread-clear-attachments");
      const messageId = MessageId.make("message-clear-attachments");
      const createdAt = "2026-02-28T19:10:00.000Z";

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        workflowPromptId: null,
        text: "with attachment",
        attachments: [
          {
            type: "image",
            id: "thread-clear-attachments-att-1",
            name: "example.png",
            mimeType: "image/png",
            sizeBytes: 5,
          },
        ],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:01.000Z",
      });

      yield* repository.upsert({
        messageId,
        threadId,
        turnId: null,
        role: "assistant",
        workflowPromptId: null,
        text: "cleared",
        attachments: [],
        isStreaming: false,
        createdAt,
        updatedAt: "2026-02-28T19:10:02.000Z",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.text, "cleared");
      assert.deepEqual(rows[0]?.attachments, []);
    }),
  );
});
