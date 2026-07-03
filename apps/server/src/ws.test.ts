import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Headers from "effect/unstable/http/Headers";

import { webSocketRequestLogAttributes } from "./ws.ts";

describe("webSocketRequestLogAttributes", () => {
  it("includes useful request metadata without URL or credential-bearing headers", () => {
    const attributes = webSocketRequestLogAttributes({
      headers: Headers.fromInput({
        "user-agent": "Test Browser",
        "cf-connecting-ip": "198.51.100.12",
        "cf-ipcountry": "DE",
        "cf-ray": "a15856837cca4da4-FRA",
        "cf-warp-tag-id": "6668cbca-eac1-4549-bdb1-a0c56b457737",
        "x-forwarded-for": "203.0.113.9",
        "x-forwarded-proto": "https",
        "x-forwarded-server": "traefik-67b45c8f98-5nxtr",
        referer: "https://environment.example.test/ws?wsTicket=secret-ticket",
      }),
      remoteAddress: Option.some("10.0.0.5"),
    });

    expect(attributes).toEqual({
      "http.remote_address": "10.0.0.5",
      "http.user_agent": "Test Browser",
      "http.forwarded_for": "203.0.113.9",
      "http.forwarded_proto": "https",
      "http.forwarded_server": "traefik-67b45c8f98-5nxtr",
      "http.cf_connecting_ip": "198.51.100.12",
      "http.cf_ipcountry": "DE",
      "http.cf_ray": "a15856837cca4da4-FRA",
      "http.cf_warp_tag_id": "6668cbca-eac1-4549-bdb1-a0c56b457737",
    });
    expect(JSON.stringify(attributes)).not.toContain("secret-ticket");
    expect(attributes).not.toHaveProperty("http.url");
    expect(attributes).not.toHaveProperty("http.referer");
  });
});
