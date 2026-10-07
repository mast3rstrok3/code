import * as Schema from "effect/Schema";

export const PreviewRecordingMode = Schema.Literals(["auto", "dom", "video"]);
export type PreviewRecordingMode = typeof PreviewRecordingMode.Type;
