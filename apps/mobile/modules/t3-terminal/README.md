# T3 Mobile Terminal Native Module

This local Expo module owns the native terminal surface for the mobile app.

The JavaScript contract is intentionally small:

- input from the native surface is emitted as `{ data: string }`
- resize from the native surface is emitted as `{ cols: number, rows: number }`
- remote PTY output is delivered by the existing `WsRpcClient.terminal` RPC stream

The iOS implementation uses the vendored `GhosttyKit.xcframework` built from the same custom-I/O
Ghostty fork used by VVTerm. `T3TerminalView` owns a `libghostty` surface and mirrors VVTerm's
custom I/O model:

1. initialize libghostty once for the process
2. create one Ghostty app and surface per native view
3. feed remote output into the surface with `ghostty_surface_feed_data`
4. send user input back to JS with the write callback
5. emit Ghostty's measured terminal size through `onResize`

Android currently implements the same view name (`T3TerminalSurface`) and event payloads so the
React Native screen and RPC code stay platform-neutral. The renderer backend can be replaced with a
future Android Ghostty build without changing JS.

Vendored Ghostty revision and license details are in `THIRD_PARTY_NOTICES.md`.
