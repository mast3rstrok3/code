export const AGENT_BROWSER_CLI_ASSOCIATED_DOC_CONTENT = `# Agent Browser CLI

Browser Dev Review uses the Vercel Labs \`agent-browser\` CLI as the only browser automation path. Do not use \`preview_*\` tools, external browser MCP servers, Playwright scripts, or a remote human browser for Browser Dev Review evidence.

Run the offline doctor before opening the target URL:

\`\`\`bash
pnpm exec agent-browser doctor --offline --quick
\`\`\`

After \`dev_review_replay_start\`, read \`namespace\`, \`session\`, \`evidenceDir\`, and \`initScriptPath\` from the returned \`agentBrowser\` metadata. Open the target URL with the RRweb init script before any page interaction:

\`\`\`bash
pnpm exec agent-browser --namespace "$namespace" --session "$session" open --init-script "$initScriptPath" "$TARGET_URL"
\`\`\`

Use Agent Browser CLI commands for all browser actions:

\`\`\`bash
pnpm exec agent-browser --namespace "$namespace" --session "$session" snapshot -i
pnpm exec agent-browser --namespace "$namespace" --session "$session" click "@ref"
pnpm exec agent-browser --namespace "$namespace" --session "$session" fill "@ref" "text"
pnpm exec agent-browser --namespace "$namespace" --session "$session" press "Enter"
pnpm exec agent-browser --namespace "$namespace" --session "$session" wait --url "**/expected"
pnpm exec agent-browser --namespace "$namespace" --session "$session" wait --text "Expected text"
pnpm exec agent-browser --namespace "$namespace" --session "$session" wait --load networkidle
pnpm exec agent-browser --namespace "$namespace" --session "$session" console
pnpm exec agent-browser --namespace "$namespace" --session "$session" errors
pnpm exec agent-browser --namespace "$namespace" --session "$session" network requests
pnpm exec agent-browser --namespace "$namespace" --session "$session" record start "$evidenceDir/browser.webm"
pnpm exec agent-browser --namespace "$namespace" --session "$session" record stop
pnpm exec agent-browser --namespace "$namespace" --session "$session" screenshot "$evidenceDir/screenshot.png"
\`\`\`

Refresh element refs with \`snapshot -i\` after every navigation, reload, route transition, DOM-changing action, or failed selector. Snapshot refs are stale after page changes and must not be reused across changed page states.

Always call \`dev_review_replay_stop\` after browser testing. If replay start fails, replay stop fails, or stop returns \`status: "failed"\` or \`eventCount: 0\`, the Browser Dev Review lacks required RRweb evidence and must be marked blocked or failed, not passed.`;
