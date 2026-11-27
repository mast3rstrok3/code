import type { ReviewTestPlatform } from "@t3tools/contracts";

export const REVIEW_TEST_PLATFORMS = ["web", "windows", "android", "ios", "macos"] as const;

/**
 * The platforms E2E tests can reach from a server on `hostPlatform`. Web runs
 * anywhere, and Android and Windows run on emulators, VMs, or cluster guests;
 * iOS and macOS need Apple hardware.
 */
export function reviewTestPlatformsForHost(
  hostPlatform: NodeJS.Platform,
): readonly ReviewTestPlatform[] {
  return hostPlatform === "darwin"
    ? REVIEW_TEST_PLATFORMS
    : REVIEW_TEST_PLATFORMS.filter((platform) => platform !== "ios" && platform !== "macos");
}
