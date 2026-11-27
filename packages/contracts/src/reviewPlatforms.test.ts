import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ReviewTestPlatforms } from "./reviewPlatforms.ts";

const decode = Schema.decodeUnknownSync(ReviewTestPlatforms);

it("requires a supported non-empty platform selection", () => {
  expect(decode(["web", "windows", "android", "ios", "macos"])).toHaveLength(5);
  expect(() => decode([])).toThrow();
  expect(() => decode(["linux"])).toThrow();
});
