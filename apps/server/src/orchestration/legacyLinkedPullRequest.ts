import type {
  RepositoryIdentity,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import {
  legacyThreadPullRequestKey,
  resolveThreadCurrentPullRequestLink,
} from "../sourceControl/threadPullRequests.ts";

/**
 * The single `linkedPullRequest` V1 thread snapshots still carry for older clients: the thread's
 * current pull request among those in the project's own repository.
 */
export function legacyLinkedPullRequestOf(
  links: ReadonlyArray<ThreadPullRequestLink>,
  projectId: ThreadLinkedPullRequest["projectId"],
  identity: RepositoryIdentity | null | undefined,
): ThreadLinkedPullRequest | null {
  if (!identity) return null;
  const host = sourceControlDefinitions.changeRequestHost(identity, identity.provider);
  if (typeof host !== "string") return null;
  const repository = sourceControlDefinitions.repositorySelector(identity);
  if (repository === null) return null;
  // Hosts with several spellings of one repository (Azure DevOps) compare canonical keys.
  const multiSpelledKey =
    sourceControlDefinitions.findByRepositoryKey(identity.canonicalKey.toLowerCase()) === undefined
      ? null
      : sourceControlDefinitions.canonicalRepositoryKey(identity.canonicalKey.toLowerCase());
  const link = resolveThreadCurrentPullRequestLink(
    links.filter((link) => {
      if (multiSpelledKey !== null) {
        const key = legacyThreadPullRequestKey(link, link.host);
        return (
          sourceControlDefinitions.canonicalRepositoryKey(`${key.host}/${key.repository}`) ===
          multiSpelledKey
        );
      }
      const parsed = sourceControlDefinitions.parseChangeRequestUrl(link.url)?.link;
      if (parsed?.authority !== undefined) {
        try {
          const remote = new URL(identity.locator.remoteUrl);
          if (remote.protocol === "http:" || remote.protocol === "https:") {
            return (
              parsed.authority === remote.host && parsed.repository === repository.toLowerCase()
            );
          }
        } catch {}
        return parsed.host === host && parsed.repository === repository.toLowerCase();
      }
      return (
        link.host.toLowerCase() === host.toLowerCase() &&
        link.repository.toLowerCase() === repository.toLowerCase()
      );
    }),
  );
  if (link === null) return null;
  return {
    projectId,
    repository: multiSpelledKey === null ? link.repository : repository,
    number: link.number,
    url: link.url,
  };
}
