import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Headers from "effect/unstable/http/Headers";

import { webSocketRequestLogAttributes } from "./ws.ts";

describe("webSocketRequestLogAttributes", () => {
  it("includes useful request metadata without URL or credential-bearing headers", () => {
    const attributes = webSocketRequestLogAttributes({
      headers: Headers.fromInput({
        "user-agent": "Test Browser",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-proto": "https",
        referer: "https://environment.example.test/ws?wsTicket=secret-ticket",
      }),
      remoteAddress: Option.some("10.0.0.5"),
    });

    expect(attributes).toEqual({
      "http.remote_address": "10.0.0.5",
      "http.user_agent": "Test Browser",
      "http.forwarded_for": "203.0.113.9",
      "http.forwarded_proto": "https",
    });
    expect(JSON.stringify(attributes)).not.toContain("secret-ticket");
    expect(attributes).not.toHaveProperty("http.url");
    expect(attributes).not.toHaveProperty("http.referer");
  });
});
