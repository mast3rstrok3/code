import { fetch as expoFetch } from "expo/fetch";
import * as ManagedRuntime from "effect/ManagedRuntime";

import { remoteHttpClientLayer } from "@t3tools/client-runtime";

export const mobileRemoteHttpRuntime = ManagedRuntime.make(remoteHttpClientLayer(expoFetch));
