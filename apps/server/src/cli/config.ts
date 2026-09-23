import * as NetService from "@t3tools/shared/Net";
import {
  OtlpHeadersFromString,
  OtlpProtocol,
  type SignalExport,
} from "@t3tools/shared/observability";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import { DesktopBackendBootstrap, PortSchema } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as LogLevel from "effect/LogLevel";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { Argument, Flag } from "effect/unstable/cli";

import { readBootstrapEnvelope } from "../bootstrap.ts";
import * as ServerConfig from "../config.ts";
import { expandHomePath, resolveBaseDir } from "../os-jank.ts";

const modeFlag = Flag.Literals("mode", ServerConfig.RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.Int("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.String("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
export const baseDirFlag = Flag.String("base-dir").pipe(
  Flag.withDescription(
    "Explicit T3 Code data directory; runtime state is stored under userdata (equivalent to T3CODE_HOME).",
  ),
  Flag.optional,
);
const devUrlFlag = Flag.String("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.Boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const bootstrapFdFlag = Flag.Int("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.Boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.Boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);
const tailscaleServeFlag = Flag.Boolean("tailscale-serve").pipe(
  Flag.withDescription(
    "Configure Tailscale Serve to expose this backend over HTTPS on the Tailnet.",
  ),
  Flag.optional,
);
const tailscaleServePortFlag = Flag.Int("tailscale-serve-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("HTTPS port for Tailscale Serve when --tailscale-serve is enabled."),
  Flag.optional,
);
export const previewBrowserFlag = Flag.Literals(
  "preview-browser",
  ServerConfig.PreviewBrowserMode.literals,
).pipe(Flag.withDescription("Server-hosted browser preview mode: auto or off."), Flag.optional);

const optionalRedactedString = (name: string) =>
  Config.Redacted(name).pipe(
    Config.option,
    Config.map((value) =>
      Option.match(value, {
        onNone: () => undefined,
        onSome: (redacted) => {
          const trimmed = Redacted.value(redacted).trim();
          return trimmed.length > 0 ? Redacted.make(trimmed) : undefined;
        },
      }),
    ),
  );

const optionalTrimmedString = (name: string) =>
  Config.String(name).pipe(
    Config.option,
    Config.map((value) =>
      Option.match(value, {
        onNone: () => undefined,
        onSome: (raw) => {
          const trimmed = raw.trim();
          return trimmed.length > 0 ? trimmed : undefined;
        },
      }),
    ),
  );

const optionalUrl = (name: string) =>
  Config.URL(name).pipe(Config.option, Config.map(Option.getOrUndefined));

// The feature was renamed from "app dev stack" to "app stack". Hosts still
// export the old T3CODE_APP_DEV_STACK_* names, so each new name falls back to
// its old one when unset. A malformed value still fails under the name that
// was actually set, because Config.option only absorbs missing data.
const APP_STACK_ENV_PREFIX = "T3CODE_APP_STACK_";
const LEGACY_APP_STACK_ENV_PREFIX = "T3CODE_APP_DEV_STACK_";

const appStackEnv = <A>(
  make: (name: string) => Config.Config<A>,
  name: string,
): Config.Config<Option.Option<A>> =>
  Config.all([
    make(name).pipe(Config.option),
    make(name.replace(APP_STACK_ENV_PREFIX, LEGACY_APP_STACK_ENV_PREFIX)).pipe(Config.option),
  ]).pipe(Config.map(([current, legacy]) => Option.orElse(current, () => legacy)));

const trimmedOrUndefined = (value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => undefined,
    onSome: (raw) => {
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    },
  });

const appStackString = (name: string) =>
  appStackEnv(Config.String, name).pipe(Config.map(trimmedOrUndefined));

const appStackUrl = (name: string) =>
  appStackEnv(Config.URL, name).pipe(Config.map(Option.getOrUndefined));

const appStackRedacted = (name: string) =>
  appStackEnv(Config.Redacted, name).pipe(
    Config.map((value) =>
      Option.match(value, {
        onNone: () => undefined,
        onSome: (redacted) => {
          const trimmed = Redacted.value(redacted).trim();
          return trimmed.length > 0 ? Redacted.make(trimmed) : undefined;
        },
      }),
    ),
  );

const deriveOidcTokenUrl = (tokenUrl: URL | undefined, issuer: URL | undefined) => {
  if (tokenUrl !== undefined) return tokenUrl;
  if (issuer === undefined) return undefined;
  return new URL(`${issuer.href.replace(/\/+$/u, "")}/protocol/openid-connect/token`);
};

const EnvServerConfig = Config.all({
  logLevel: Config.LogLevel("T3CODE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.LogLevel("T3CODE_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.Boolean("T3CODE_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: Config.String("T3CODE_TRACE_FILE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceMaxBytes: Config.Int("T3CODE_TRACE_MAX_BYTES").pipe(Config.withDefault(10 * 1024 * 1024)),
  traceMaxFiles: Config.Int("T3CODE_TRACE_MAX_FILES").pipe(Config.withDefault(10)),
  traceBatchWindowMs: Config.Int("T3CODE_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(1_000)),
  otlpTracesUrl: Config.String("T3CODE_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.String("T3CODE_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpLogsUrl: Config.String("T3CODE_OTLP_LOGS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: Config.Int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpServiceName: Config.String("T3CODE_OTLP_SERVICE_NAME").pipe(Config.withDefault("t3-server")),
  otlpHeaders: Config.schema(OtlpHeadersFromString, "T3CODE_OTLP_HEADERS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpProtocol: Config.schema(OtlpProtocol, "T3CODE_OTLP_PROTOCOL").pipe(
    Config.withDefault("http/json"),
  ),
  mode: Config.schema(ServerConfig.RuntimeMode, "T3CODE_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.Port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.String("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3Home: Config.String("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.URL("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  appStackBackendUrl: appStackUrl("T3CODE_APP_STACK_BACKEND_URL"),
  appStackBackendBearerToken: appStackRedacted("T3CODE_APP_STACK_BACKEND_BEARER_TOKEN"),
  appStackBackendOidcTokenUrl: appStackUrl("T3CODE_APP_STACK_BACKEND_OIDC_TOKEN_URL"),
  appStackBackendOidcIssuer: appStackUrl("T3CODE_APP_STACK_BACKEND_OIDC_ISSUER"),
  appStackBackendOidcClientId: appStackString("T3CODE_APP_STACK_BACKEND_OIDC_CLIENT_ID"),
  appStackBackendOidcClientSecret: appStackRedacted("T3CODE_APP_STACK_BACKEND_OIDC_CLIENT_SECRET"),
  appStackNativeEnabled: appStackEnv(Config.Boolean, "T3CODE_APP_STACK_NATIVE_ENABLED").pipe(
    Config.map(Option.getOrElse(() => false)),
  ),
  appStackNativeId: appStackString("T3CODE_APP_STACK_NATIVE_ID"),
  appStackNativeNamespace: appStackString("T3CODE_APP_STACK_NATIVE_NAMESPACE"),
  appStackNativeWorktreePath: appStackString("T3CODE_APP_STACK_NATIVE_WORKTREE_PATH"),
  appStackNativeComposePath: appStackString("T3CODE_APP_STACK_NATIVE_COMPOSE_PATH"),
  appStackNativeDisplayName: appStackString("T3CODE_APP_STACK_NATIVE_DISPLAY_NAME"),
  appStackNativeDisplaySlug: appStackString("T3CODE_APP_STACK_NATIVE_DISPLAY_SLUG"),
  appStackNativeRepoName: appStackString("T3CODE_APP_STACK_NATIVE_REPO_NAME"),
  appStackNativeBranchName: appStackString("T3CODE_APP_STACK_NATIVE_BRANCH_NAME"),
  appStackNativeKubectlPath: appStackString("T3CODE_APP_STACK_NATIVE_KUBECTL"),
  appStackNativeDockerPath: appStackString("T3CODE_APP_STACK_NATIVE_DOCKER"),
  appStackNativeBuildctlPath: appStackString("T3CODE_APP_STACK_NATIVE_BUILDCTL"),
  appStackNativeImageBuilder: appStackEnv(
    (name) => Config.schema(ServerConfig.NativeAppStackImageBuilder, name),
    "T3CODE_APP_STACK_NATIVE_IMAGE_BUILDER",
  ).pipe(Config.map(Option.getOrElse(() => "auto" as const))),
  appStackNativeImageRegistry: appStackString("T3CODE_APP_STACK_NATIVE_IMAGE_REGISTRY"),
  appStackNativeImagePushRegistry: appStackString("T3CODE_APP_STACK_NATIVE_IMAGE_PUSH_REGISTRY"),
  appStackNativeImageProject: appStackString("T3CODE_APP_STACK_NATIVE_IMAGE_PROJECT"),
  appStackNativeBuildkitAddr: appStackString("T3CODE_APP_STACK_NATIVE_BUILDKIT_ADDR"),
  appStackNativeBuildkitDockerConfig: appStackString(
    "T3CODE_APP_STACK_NATIVE_BUILDKIT_DOCKER_CONFIG",
  ),
  appStackNativeBuildkitDockerConfigsDir: appStackString(
    "T3CODE_APP_STACK_NATIVE_BUILDKIT_DOCKER_CONFIGS_DIR",
  ),
  appStackNativeBuildkitHarborCaCert: appStackString(
    "T3CODE_APP_STACK_NATIVE_BUILDKIT_HARBOR_CA_CERT",
  ),
  appStackNativeFrontendUrl: appStackString("T3CODE_APP_STACK_NATIVE_FRONTEND_URL"),
  appStackNativeBackendUrl: appStackString("T3CODE_APP_STACK_NATIVE_BACKEND_URL"),
  appStackNativeKeycloakUrl: appStackString("T3CODE_APP_STACK_NATIVE_KEYCLOAK_URL"),
  // MINIO_URL is the former name. Hosts that still export it keep working.
  appStackNativeObjectStorageUrl: Config.all([
    appStackString("T3CODE_APP_STACK_NATIVE_OBJECT_STORAGE_URL"),
    appStackString("T3CODE_APP_STACK_NATIVE_MINIO_URL"),
  ]).pipe(Config.map(([current, former]) => current ?? former)),
  codeOidcIssuer: optionalUrl("CODE_OIDC_ISSUER"),
  codeOidcClientId: optionalTrimmedString("CODE_OIDC_CLIENT_ID"),
  codeOidcClientSecret: optionalRedactedString("CODE_OIDC_CLIENT_SECRET"),
  devAllowedOrigins: Config.String("T3CODE_DEV_ALLOWED_ORIGINS").pipe(
    Config.withDefault(""),
    Config.map((value) =>
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ),
  noBrowser: Config.Boolean("T3CODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  bootstrapFd: Config.Int("T3CODE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.Boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.Boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServeEnabled: Config.Boolean("T3CODE_TAILSCALE_SERVE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  tailscaleServePort: Config.Port("T3CODE_TAILSCALE_SERVE_PORT").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  previewBrowserMode: Config.schema(ServerConfig.PreviewBrowserMode, "T3CODE_PREVIEW_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  previewBrowserSource: Config.schema(
    ServerConfig.PreviewBrowserSource,
    "T3CODE_PREVIEW_BROWSER_SOURCE",
  ).pipe(Config.withDefault("auto")),
  previewBrowserExecutablePath: optionalTrimmedString("T3CODE_PREVIEW_BROWSER_EXECUTABLE"),
  previewFfmpegExecutablePath: optionalTrimmedString("T3CODE_PREVIEW_FFMPEG_EXECUTABLE"),
  previewBrowserSandbox: Config.schema(
    ServerConfig.PreviewBrowserSandbox,
    "T3CODE_PREVIEW_BROWSER_SANDBOX",
  ).pipe(Config.withDefault("auto")),
  previewBrowserMaxFps: Config.Int("T3CODE_PREVIEW_BROWSER_MAX_FPS").pipe(Config.withDefault(12)),
  previewBrowserMaxFrameWidth: Config.Int("T3CODE_PREVIEW_BROWSER_MAX_FRAME_WIDTH").pipe(
    Config.withDefault(1600),
  ),
  previewBrowserMaxFrameHeight: Config.Int("T3CODE_PREVIEW_BROWSER_MAX_FRAME_HEIGHT").pipe(
    Config.withDefault(1200),
  ),
  previewBrowserJpegQuality: Config.Int("T3CODE_PREVIEW_BROWSER_JPEG_QUALITY").pipe(
    Config.withDefault(75),
  ),
  previewBrowserIdleTtlMs: Config.Int("T3CODE_PREVIEW_BROWSER_IDLE_TTL_MS").pipe(
    Config.withDefault(600_000),
  ),
  previewRecordingMode: Config.schema(
    ServerConfig.PreviewRecordingMode,
    "T3CODE_PREVIEW_RECORDING_MODE",
  ).pipe(Config.withDefault("auto")),
});

const DevAuthTokenConfig = Config.Redacted("T3CODE_DEV_AUTH_TOKEN").pipe(
  Config.map((token) => Redacted.make(Redacted.value(token).trim())),
  Config.mapEffect((token) =>
    Redacted.value(token).length === 0 || Redacted.value(token).length >= 32
      ? Effect.succeed(token)
      : Effect.fail(
          new Config.ConfigError(
            new Schema.SchemaError(
              new SchemaIssue.InvalidValue({
                message: "T3CODE_DEV_AUTH_TOKEN must contain at least 32 characters.",
              }),
            ),
          ),
        ),
  ),
  Config.option,
  Config.map(Option.filter((token) => Redacted.value(token).length > 0)),
  Config.map(Option.getOrUndefined),
);

export interface CliServerFlags {
  readonly mode: Option.Option<ServerConfig.RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
  readonly tailscaleServeEnabled: Option.Option<boolean>;
  readonly tailscaleServePort: Option.Option<number>;
  readonly previewBrowserMode?: Option.Option<ServerConfig.PreviewBrowserMode>;
}

export interface CliAuthLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
}

export const authLocationFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

export const projectLocationFlags = {
  baseDir: baseDirFlag,
} as const;

export const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.String("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
  tailscaleServeEnabled: tailscaleServeFlag,
  tailscaleServePort: tailscaleServePortFlag,
  previewBrowserMode: previewBrowserFlag,
} as const;

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService.NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      mode: flags.mode ?? Option.none(),
      port: flags.port ?? Option.none(),
      host: flags.host ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: flags.noBrowser ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
      tailscaleServeEnabled: flags.tailscaleServeEnabled ?? Option.none(),
      tailscaleServePort: flags.tailscaleServePort ?? Option.none(),
      previewBrowserMode: flags.previewBrowserMode ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(DesktopBackendBootstrap, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

    const mode: ServerConfig.RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.fromUndefinedOr(bootstrap?.mode),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(ServerConfig.DEFAULT_PORT);
          }
          return findAvailablePort(ServerConfig.DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(normalizedFlags.devUrl, Option.fromUndefinedOr(env.devUrl)),
      () => undefined,
    );
    const devAuthToken =
      mode === "web" && devUrl !== undefined ? yield* DevAuthTokenConfig : undefined;
    const explicitBaseDir = resolveOptionPrecedence(
      normalizedFlags.baseDir,
      Option.fromUndefinedOr(env.t3Home),
    ).pipe(Option.filter((value) => value.trim().length > 0));
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(explicitBaseDir, Option.fromUndefinedOr(bootstrap?.t3Home)),
      ),
    );
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
      baseDirIsExplicit: Option.isSome(explicitBaseDir),
    });
    yield* ServerConfig.ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(env.noBrowser),
        Option.fromUndefinedOr(bootstrap?.noBrowser),
      ),
      () => mode === "desktop",
    );
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const desktopTelemetryFd = bootstrap?.desktopTelemetryFd;
    const desktopTelemetryControlFd = bootstrap?.desktopTelemetryControlFd;
    const resourceMonitorPath = bootstrap?.resourceMonitorPath;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
      ),
      () => mode === "web",
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const tailscaleServeEnabled = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServeEnabled,
        Option.fromUndefinedOr(env.tailscaleServeEnabled),
        Option.fromUndefinedOr(bootstrap?.tailscaleServeEnabled),
      ),
      () => false,
    );
    const tailscaleServePort = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.tailscaleServePort,
        Option.fromUndefinedOr(env.tailscaleServePort),
        Option.fromUndefinedOr(bootstrap?.tailscaleServePort),
      ),
      () => 443,
    );
    const previewBrowserMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.previewBrowserMode,
        Option.fromUndefinedOr(env.previewBrowserMode),
      ),
      () => "auto" as const,
    );
    const staticDir = devUrl ? undefined : yield* ServerConfig.resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);
    const appStackBackendOidcIssuer = env.appStackBackendOidcIssuer ?? env.codeOidcIssuer;
    const appStackNativeWorktreePath =
      env.appStackNativeWorktreePath === undefined
        ? undefined
        : path.resolve(yield* expandHomePath(env.appStackNativeWorktreePath));
    const appStackNative: ServerConfig.NativeAppStackConfig | undefined = env.appStackNativeEnabled
      ? {
          id: env.appStackNativeId,
          namespace: env.appStackNativeNamespace,
          worktreePath: appStackNativeWorktreePath,
          composePath: env.appStackNativeComposePath ?? "infra/compose/compose.app-dev.yml",
          displayName: env.appStackNativeDisplayName,
          displaySlug: env.appStackNativeDisplaySlug,
          repoName: env.appStackNativeRepoName,
          branchName: env.appStackNativeBranchName,
          kubectlPath: env.appStackNativeKubectlPath ?? "kubectl",
          dockerPath: env.appStackNativeDockerPath ?? "docker",
          buildctlPath: env.appStackNativeBuildctlPath ?? "buildctl",
          imageBuilder: env.appStackNativeImageBuilder,
          imageRegistry: env.appStackNativeImageRegistry ?? "harbor.nightingale-ai.com",
          imagePushRegistry: env.appStackNativeImagePushRegistry,
          imageProject: env.appStackNativeImageProject,
          buildkitAddr: env.appStackNativeBuildkitAddr,
          buildkitDockerConfig: env.appStackNativeBuildkitDockerConfig,
          buildkitDockerConfigsDir: env.appStackNativeBuildkitDockerConfigsDir,
          buildkitHarborCaCert: env.appStackNativeBuildkitHarborCaCert,
          frontendUrl: env.appStackNativeFrontendUrl,
          backendUrl: env.appStackNativeBackendUrl,
          keycloakUrl: env.appStackNativeKeycloakUrl,
          objectStorageUrl: env.appStackNativeObjectStorageUrl,
        }
      : undefined;

    // T3 Code's own OTLP variables name no signal, so the one answer they give
    // is the answer for all three.
    const signalExport: SignalExport = {
      protocol: env.otlpProtocol,
      headers: env.otlpHeaders,
      exportIntervalMs: env.otlpExportIntervalMs,
    };

    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl:
        env.otlpTracesUrl ??
        bootstrap?.otlpTracesUrl ??
        persistedObservabilitySettings.otlpTracesUrl,
      otlpMetricsUrl:
        env.otlpMetricsUrl ??
        bootstrap?.otlpMetricsUrl ??
        persistedObservabilitySettings.otlpMetricsUrl,
      otlpLogsUrl:
        env.otlpLogsUrl ?? bootstrap?.otlpLogsUrl ?? persistedObservabilitySettings.otlpLogsUrl,
      otlpTracesExport: signalExport,
      otlpMetricsExport: signalExport,
      otlpLogsExport: signalExport,
      otlpServiceName: env.otlpServiceName,
      mode,
      port,
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      appStackBackendUrl: env.appStackBackendUrl,
      appStackBackendBearerToken: env.appStackBackendBearerToken,
      appStackBackendOidcTokenUrl: deriveOidcTokenUrl(
        env.appStackBackendOidcTokenUrl,
        appStackBackendOidcIssuer,
      ),
      appStackBackendOidcClientId: env.appStackBackendOidcClientId ?? env.codeOidcClientId,
      appStackBackendOidcClientSecret:
        env.appStackBackendOidcClientSecret ?? env.codeOidcClientSecret,
      appStackNative,
      ...(devAuthToken === undefined ? {} : { devAuthToken }),
      devAllowedOrigins: env.devAllowedOrigins,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken,
      desktopTelemetryFd,
      desktopTelemetryControlFd,
      resourceMonitorPath,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
      tailscaleServeEnabled,
      tailscaleServePort,
      previewBrowserMode,
      previewBrowserSource: env.previewBrowserSource,
      previewBrowserExecutablePath: env.previewBrowserExecutablePath,
      previewFfmpegExecutablePath: env.previewFfmpegExecutablePath,
      previewBrowserSandbox: env.previewBrowserSandbox,
      previewBrowserMaxFps: Math.max(1, Math.min(60, env.previewBrowserMaxFps)),
      previewBrowserMaxFrameWidth: Math.max(240, Math.min(3840, env.previewBrowserMaxFrameWidth)),
      previewBrowserMaxFrameHeight: Math.max(240, Math.min(2160, env.previewBrowserMaxFrameHeight)),
      previewBrowserJpegQuality: Math.max(1, Math.min(100, env.previewBrowserJpegQuality)),
      previewBrowserIdleTtlMs: Math.max(60_000, env.previewBrowserIdleTtlMs),
      previewRecordingMode: env.previewRecordingMode,
    };

    return config;
  });

export const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  resolveServerConfig(
    {
      mode: Option.none(),
      port: Option.none(),
      host: Option.none(),
      baseDir: flags.baseDir,
      cwd: Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.none(),
      logWebSocketEvents: Option.none(),
      tailscaleServeEnabled: Option.none(),
      tailscaleServePort: Option.none(),
      previewBrowserMode: Option.none(),
    },
    cliLogLevel,
  );

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue({
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);
