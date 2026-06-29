export const CHROME_DEVTOOLS_MCP_SERVER_NAME = "chrome-devtools";
export const CHROME_DEVTOOLS_MCP_COMMAND = "npx";
export const CHROME_DEVTOOLS_MCP_ARGS = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--headless",
  "--isolated",
  "--executablePath=/home/nils/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
  "--no-usage-statistics",
  "--no-performance-crux",
  "--redact-network-headers",
  "--screenshot-format=webp",
  "--screenshot-max-width=1600",
  "--screenshot-max-height=1200",
] as const;

export const CHROME_DEVTOOLS_MCP_ASSOCIATED_DOC_CONTENT = `# Chrome DevTools MCP

This MCP server is for the Browser Dev Review QA role only. Do not add it to global/default Codex context, ordinary implementation threads, planning threads, Product Grill threads, or generic agent instructions.

The server may inspect page contents, console messages, network requests, screenshots, and performance traces. Keep its configuration scoped to the Browser Dev Review provider session.

QA-only server command:

\`\`\`bash
npx -y chrome-devtools-mcp@latest \\
  --headless \\
  --isolated \\
  --executablePath=/home/nils/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome \\
  --no-usage-statistics \\
  --no-performance-crux \\
  --redact-network-headers \\
  --screenshot-format=webp \\
  --screenshot-max-width=1600 \\
  --screenshot-max-height=1200
\`\`\`

Expected Chrome DevTools MCP tools include:

- Input automation: click, drag, fill, fill_form, handle_dialog, hover, press_key, type_text, upload_file, click_at.
- Navigation automation: close_page, list_pages, navigate_page, new_page, select_page, wait_for.
- Emulation: emulate, resize_page.
- Performance: performance_analyze_insight, performance_start_trace, performance_stop_trace.
- Network: get_network_request, list_network_requests.
- Debugging: evaluate_script, get_console_message, lighthouse_audit, list_console_messages, take_screenshot, take_snapshot, screencast_start, screencast_stop.
- Memory: take_heapsnapshot, close_heapsnapshot, get_heapsnapshot_class_nodes, get_heapsnapshot_details, get_heapsnapshot_dominators, get_heapsnapshot_edges, get_heapsnapshot_retainers, get_heapsnapshot_retaining_paths, get_heapsnapshot_summary.
- Extensions: install_extension, list_extensions, reload_extension, trigger_extension_action, uninstall_extension.
- Third-party/WebMCP: execute_3p_developer_tool, list_3p_developer_tools, execute_webmcp_tool, list_webmcp_tools.`;

const tomlString = (value: string) => JSON.stringify(value);
const tomlArray = (values: ReadonlyArray<string>) => `[${values.map(tomlString).join(",")}]`;

export function buildCodexChromeDevtoolsMcpAppServerArgs(): string[] {
  return [
    "-c",
    `mcp_servers.${CHROME_DEVTOOLS_MCP_SERVER_NAME}.command=${tomlString(
      CHROME_DEVTOOLS_MCP_COMMAND,
    )}`,
    "-c",
    `mcp_servers.${CHROME_DEVTOOLS_MCP_SERVER_NAME}.args=${tomlArray(CHROME_DEVTOOLS_MCP_ARGS)}`,
  ];
}

export function buildClaudeChromeDevtoolsMcpServerConfig() {
  return {
    type: "stdio" as const,
    command: CHROME_DEVTOOLS_MCP_COMMAND,
    args: [...CHROME_DEVTOOLS_MCP_ARGS],
  };
}
