# Shipping the fork's iOS app through TestFlight

This fork can't sign or build the iOS app as T3 Tools, so it builds in its own
EAS project, `@mast3rstrok3/t3-code`, with Apple team `7V8BA67W22` and bundle
ID `com.nightingaleai.code`. Those values live in the `fork` build profile in
`apps/mobile/eas.json`; every other profile still builds the T3 Tools app.

From `apps/mobile`, run EAS through `pnpm eas:fork <args>`, not bare `eas`.
Only `eas build` applies a profile's env, so a bare `eas submit` or
`eas build:list` resolves the T3 Tools project instead. Build on Linux: under
the fingerprint runtime policy, a macOS build computes a fingerprint that
doesn't match the EAS worker's.

## Building for TestFlight

The App Store Connect app is "Code by Ivelion" (`ascAppId` 6829406701), and
signing credentials for the app and its two extensions are stored on EAS. Load
the team's App Store Connect API key, then build and submit in one step:

```sh
set -a; . ~/.config/rudi-expo/asc/env; set +a
pnpm testflight:fork
```

The build number increments on EAS. Install builds through an internal
TestFlight group.

When a change adds an iOS capability or entitlement, run that build without the
API key and log in with an Apple ID when EAS asks. Apple rejects capability
changes made with an API key ("Failed to sync capabilities"), but accepts them
from an Apple ID session.

## Connecting the app

Pair the app with a server from that server's Settings → Connections, using
its pairing link or QR code. T3 Connect sign-in and the relay belong to T3
Tools' identity, so they don't work in this build.
