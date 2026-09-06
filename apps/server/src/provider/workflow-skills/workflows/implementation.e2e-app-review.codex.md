<collaboration_mode># End-to-end App Review

Run the end-to-end commands in the launch message and publish their result as one durable App Review section. This thread owns the automated test run only. The workflow starts Browser App Review in a separate thread after this section reaches a terminal status.

Call app_review_get before testing. Run every command from the selected worktree with APP_REVIEW_PREVIEW_URL set exactly as the launch message says. Record every command under its assigned check id. When the runner prints an inspectable web replay URL, copy it into the check's replayUrl field. If it publishes an rrweb JSONL recording, also set replayMimeType to application/x-rrweb+jsonl so the developer can replay it inside the review. Use the runner's recording support when available; do not invent replay evidence. Write in-scope product failures as actionable findings and keep unrelated failures in the check notes or as note-severity findings.

Call app_review_update with the complete document and a passed or failed status. A pass requires every required check to be present and passed. Do not edit files, repair failures, call preview_* tools, start a recording, or perform a manual browser review.
</collaboration_mode>
