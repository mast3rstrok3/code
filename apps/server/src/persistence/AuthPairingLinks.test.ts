import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as AuthPairingLinks from "./AuthPairingLinks.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const layer = AuthPairingLinks.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-10-07T00:00:00.000Z");
const expiresAt = DateTime.add(now, { hours: 1 });

describe("pairing link consumption", () => {
  it.effect("consumes a one-time browser credential without a scope filter", () =>
    Effect.gen(function* () {
      const links = yield* AuthPairingLinks.AuthPairingLinkRepository;
      yield* links.create({
        id: "browser-link",
        credential: "test-browser-credential",
        method: "one-time-token",
        scopes: ["orchestration:read"],
        subject: "test-browser",
        label: null,
        proofKeyThumbprint: null,
        createdAt: now,
        expiresAt,
      });
      const input = {
        credential: "test-browser-credential",
        proofKeyThumbprint: null,
        consumedAt: now,
        now,
      };
      const consumed = yield* links.consumeAvailable(input);
      assert.isTrue(Option.isSome(consumed));
      assert.isTrue(Option.isNone(yield* links.consumeAvailable(input)));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a denied link available for a matching scope", () =>
    Effect.gen(function* () {
      const links = yield* AuthPairingLinks.AuthPairingLinkRepository;
      yield* links.create({
        id: "scoped-link",
        credential: "test-scoped-credential",
        method: "one-time-token",
        scopes: ["orchestration:read"],
        subject: "test-browser",
        label: null,
        proofKeyThumbprint: null,
        createdAt: now,
        expiresAt,
      });
      const input = {
        credential: "test-scoped-credential",
        proofKeyThumbprint: null,
        consumedAt: now,
        now,
      };
      assert.isTrue(
        Option.isNone(
          yield* links.consumeAvailable({ ...input, requestedScopes: ["access:write"] }),
        ),
      );
      assert.isTrue(
        Option.isSome(
          yield* links.consumeAvailable({ ...input, requestedScopes: ["orchestration:read"] }),
        ),
      );
    }).pipe(Effect.provide(layer)),
  );
});
