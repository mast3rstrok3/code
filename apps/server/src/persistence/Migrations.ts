import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";
import Migration0102 from "./Migrations/055_OrchestrationV2.ts";
import Migration0103 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Migration0104 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0107 from "./Migrations/059_McpAppModelContext.ts";
import Migration0106 from "./Migrations/106_WorkflowEventHistory.ts";
import Migration0108 from "./Migrations/108_RetireQuickWorkflowPresets.ts";
import Migration0105 from "./Migrations/058_WebhookRelayDeliveries.ts";

import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadsOwnerUserId.ts";
import Migration0044 from "./Migrations/044_BackfillProjectionThreadOwnerUserId.ts";
import Migration0045 from "./Migrations/045_ProjectionThreadDevReviews.ts";
import Migration0046 from "./Migrations/046_ProjectionThreadsWorkflowColumns.ts";
import Migration0047 from "./Migrations/047_ProjectionThreadSpecs.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadPlanningTickets.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadPlanningReviewCycles.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadLoadedSpecBundles.ts";
import Migration0051 from "./Migrations/051_ProjectionImplementationRuns.ts";
import Migration0053 from "./Migrations/053_ScopePlanningReviewCycleMessageIndex.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadDevReviewEvidenceColumn.ts";
import Migration0055 from "./Migrations/055_RejectLegacyWorkflowDatabase.ts";
import Migration0056 from "./Migrations/056_ProjectionWorkflowSubagentBatches.ts";
import Migration0057 from "./Migrations/057_WorkflowArtifactLineage.ts";
import Migration0058 from "./Migrations/058_PlanningTicketPlannedFileChanges.ts";
import Migration0059 from "./Migrations/059_WorkflowPresetsAndFastFeatureRuns.ts";
import Migration0062 from "./Migrations/062_DevReviewSourceProposedPlan.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0063 from "./Migrations/063_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0087 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0069 from "./Migrations/069_ProjectionDevReviewWorkflowRuns.ts";
import Migration0070 from "./Migrations/070_WorkflowParentIdentity.ts";
import Migration0071 from "./Migrations/071_AppReviewRename.ts";
import Migration0072 from "./Migrations/072_BinaryAppReviewResults.ts";
import Migration0073 from "./Migrations/073_ProjectionThreadMessageWorkflowPromptId.ts";
import Migration0074 from "./Migrations/074_PlanningTicketAppReviewMetadata.ts";
import Migration0075 from "./Migrations/075_ProjectionThreadWorkflowStepModels.ts";
import Migration0076 from "./Migrations/076_ProjectionThreadWorkflowPause.ts";
import Migration0077 from "./Migrations/077_ProjectionProjectsPreviewRecordingMode.ts";
import Migration0078 from "./Migrations/078_ProjectionThreadWorkflowStepCycles.ts";
import Migration0079 from "./Migrations/079_PlanningTicketAppReviewScope.ts";
import Migration0080 from "./Migrations/080_ProjectionThreadWorkflowStepReviewParts.ts";
import Migration0082 from "./Migrations/082_ProjectionThreadWorkflowImplementationSettings.ts";
import Migration0083 from "./Migrations/083_OrchestrationCommandReceiptResults.ts";
import Migration0084 from "./Migrations/084_AppReviewScope.ts";
import Migration0088 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0089 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0090 from "./Migrations/047_ProjectionProjectIcon.ts";

import Migration0091 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0092 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0093 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0095 from "./Migrations/095_PlanningTicketAppReviewCommands.ts";
import Migration0094 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0096 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0097 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0098 from "./Migrations/098_ProjectionProjectsOwnerUserId.ts";
import Migration0099 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0100 from "./Migrations/100_PlanningTicketAppStack.ts";
import Migration0101 from "./Migrations/101_PlanningTicketProject.ts";
import Migration0109 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import Migration0110 from "./Migrations/061_PullRequestReviewGuides.ts";
import Migration0111 from "./Migrations/062_ThreadFailureLookupIndex.ts";

import Migration0112 from "./Migrations/064_CanonicalizeThreadPullRequestLinks.ts";

import Migration0113 from "./Migrations/065_CodexUsageNativeTurnIndex.ts";

import Migration0114 from "./Migrations/066_RepairClientSettlementTimestamps.ts";

import Migration0115 from "./Migrations/067_WebhookDedupe.ts";
import Migration0116 from "./Migrations/116_ScheduledTaskWorkflow.ts";

export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadsOwnerUserId", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "BackfillProjectionThreadOwnerUserId", Migration0044],
  [45, "ProjectionThreadDevReviews", Migration0045],
  [46, "ProjectionThreadsWorkflowColumns", Migration0046],
  [47, "ProjectionThreadSpecs", Migration0047],
  [48, "ProjectionThreadPlanningTickets", Migration0048],
  [49, "ProjectionThreadPlanningReviewCycles", Migration0049],
  [50, "ProjectionThreadLoadedSpecBundles", Migration0050],
  [51, "ProjectionImplementationRuns", Migration0051],
  [53, "ScopePlanningReviewCycleMessageIndex", Migration0053],
  [54, "ProjectionThreadDevReviewEvidenceColumn", Migration0054],
  [55, "RejectLegacyWorkflowDatabase", Migration0055],
  [56, "ProjectionWorkflowSubagentBatches", Migration0056],
  [57, "WorkflowArtifactLineage", Migration0057],
  [58, "PlanningTicketPlannedFileChanges", Migration0058],
  [59, "WorkflowPresetsAndFastFeatureRuns", Migration0059],
  // Fork databases may already be at migration 59, which means upstream's new
  // 33/34 migrations would be skipped. Re-run their idempotent effects at the
  // next available IDs so existing databases receive the same columns.
  [60, "ProjectionThreadsSettledCompatibility", Migration0033],
  [61, "ProjectionThreadsSnoozedCompatibility", Migration0034],
  [62, "DevReviewSourceProposedPlan", Migration0062],
  [63, "ProjectionThreadTitleRegeneration", Migration0063],
  // Fork databases may already be at migration 63, which means the upstream
  // 36-40 migrations are skipped. Re-run their idempotent effects at new IDs.
  [64, "ProjectionThreadsPinnedCompatibility", Migration0036],
  [65, "ProjectionTurnsKeysetIndexCompatibility", Migration0037],
  [66, "ProjectionThreadsPinOrderKeyCompatibility", Migration0038],
  [67, "ProjectionProjectsDefaultThreadEnvModeCompatibility", Migration0039],
  [68, "ProjectionProjectFaviconPathCompatibility", Migration0040],
  [69, "ProjectionDevReviewWorkflowRuns", Migration0069],
  [70, "WorkflowParentIdentity", Migration0070],
  [71, "AppReviewRename", Migration0071],
  [72, "BinaryAppReviewResults", Migration0072],
  [73, "ProjectionThreadMessageWorkflowPromptId", Migration0073],
  [74, "PlanningTicketAppReviewMetadata", Migration0074],
  [75, "ProjectionThreadWorkflowStepModels", Migration0075],
  [76, "ProjectionThreadWorkflowPause", Migration0076],
  [77, "ProjectionProjectsPreviewRecordingMode", Migration0077],
  [78, "ProjectionThreadWorkflowStepCycles", Migration0078],
  [79, "PlanningTicketAppReviewScope", Migration0079],
  [80, "ProjectionThreadWorkflowStepReviewParts", Migration0080],
  [81, "AuthSessionClientConnectionCompatibility", Migration0041],
  [82, "ProjectionThreadWorkflowImplementationSettings", Migration0082],
  [83, "OrchestrationCommandReceiptResults", Migration0083],
  [84, "AppReviewScope", Migration0084],
  // Fork databases may already be at migration 84, which means upstream's
  // 42/43 migrations are skipped. Re-run their idempotent effects at new IDs.
  [85, "ProjectionThreadLinkedPullRequestCompatibility", Migration0042],
  [86, "ProjectionThreadsUnsettledAtCompatibility", Migration0043],
  // Upstream assigned this migration ID 44 after the fork had already used
  // that ID. Run the same migration at the next fork-safe ID.
  [87, "ClearAutomaticProjectModelDefaults", Migration0087],
  // Upstream later reused IDs 45-47. Run those migrations at unused fork IDs.
  [88, "ProjectionProjectsAutoPull", Migration0088],
  [89, "RepairAutomaticSettlementTimestamps", Migration0089],
  [90, "ProjectionProjectIcon", Migration0090],
  [91, "ProjectionThreadBranchPullRequest", Migration0091],
  [92, "ProjectionThreadsActiveOrderKey", Migration0092],
  [93, "ProjectionThreadPullRequests", Migration0093],
  [94, "ProjectionThreadMessageContext", Migration0094],
  [95, "PlanningTicketAppReviewCommands", Migration0095],
  // Upstream IDs 52-53 are also taken by the fork. Run them at unused fork IDs.
  [96, "ProjectionThreadTitleState", Migration0096],
  [97, "PullRequestFilesViewed", Migration0097],
  [98, "ProjectionProjectsOwnerUserId", Migration0098],
  // Upstream ID 54 is also taken by the fork. Run it at the next unused fork ID.
  [99, "ProjectionThreadsAutoSettleDisabledAt", Migration0099],
  [100, "PlanningTicketAppStack", Migration0100],
  [101, "PlanningTicketProject", Migration0101],
  // Upstream 55 through 58 overlap the fork's existing migration ledger.
  [102, "OrchestrationV2", Migration0102],
  [103, "RemoveRedundantProjectionIndexes", Migration0103],
  [104, "ScheduledTaskWebhooks", Migration0104],
  [105, "WebhookRelayDeliveries", Migration0105],
  [106, "WorkflowEventHistory", Migration0106],
  // Upstream ID 59 is already in the fork ledger.
  [107, "McpAppModelContext", Migration0107],
  [108, "RetireQuickWorkflowPresets", Migration0108],
  // Upstream 60 through 62 overlap the fork's existing migration ledger. Upstream 63
  // (DropUnusedV1Projections) is not run: the fork's workflow metadata layer still
  // reads and writes those V1 projections.
  [109, "ThreadSnapshotWindowIndexes", Migration0109],
  [110, "PullRequestReviewGuides", Migration0110],
  [111, "ThreadFailureLookupIndex", Migration0111],
  [112, "CanonicalizeThreadPullRequestLinks", Migration0112],
  [113, "CodexUsageNativeTurnIndex", Migration0113],
  [114, "RepairClientSettlementTimestamps", Migration0114],
  [115, "WebhookDedupe", Migration0115],
  [116, "ScheduledTaskWorkflow", Migration0116],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

// The fork runs upstream's V2 migration (upstream id 55) at id 102.
const FIRST_V2_MIGRATION_ID = 102;

/**
 * Fail before migrating when the migrator would skip one of V2's own
 * migrations. It skips every id up to the highest recorded one, whatever name
 * was recorded, so a database that took a V2 id for another migration would
 * start without V2's schema and fail on first use.
 */
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = migrationEntries.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    if (recordedName === name) return [];
    return [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  const previewMigrations = includesV2 ? yield* reconcileV2PreviewMigration() : [];
  if (includesV2) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  const executedMigrations = [
    ...previewMigrations,
    ...(yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })),
  ];
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});
