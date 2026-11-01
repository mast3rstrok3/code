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

Load the App Store Connect API key for the team before running EAS. With the key
loaded, signing and uploads run without an Apple ID prompt:

```sh
set -a; . ~/.config/rudi-expo/asc/env; set +a
```

## First build

1. Run `pnpm eas:fork build --platform ios --profile fork`.
   It registers the app and its widget and share-extension bundle IDs, creates
   signing credentials and builds in the cloud.
2. In App Store Connect, create a new iOS app for `com.nightingaleai.code`. The
   name "T3 Code" is taken; the submit profile uses "Nightingale Code". Copy the
   app's numeric Apple ID into `submit.fork.ios.ascAppId` in `eas.json`.
3. Run `pnpm eas:fork submit --platform ios --profile fork --latest`.
4. In App Store Connect, add yourself to an internal TestFlight group, then
   install the build with the TestFlight app.

## Later builds

```sh
pnpm testflight:fork
```

This builds and submits in one step. The build number increments on EAS.

## Connecting the app

Pair the app with a server from that server's Settings → Connections, using
its pairing link or QR code. T3 Connect sign-in and the relay belong to T3
Tools' identity, so they don't work in this build.
