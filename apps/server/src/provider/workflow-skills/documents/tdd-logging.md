# Logging for TDD implementation

Adapted for T3 Code from Boris Tane's MIT-licensed [Logging Best Practices skill](https://github.com/boristane/agent-skills/tree/main/skills/logging-best-practices), version 1.0.0.

## Mental model

Logs should answer "what happened to this operation?" They should not narrate every line of code. Scattered string logs are optimized for being easy to write, not for answering production questions later.

Structured logging is necessary but not sufficient. Key-value logs are the starting point, but the target shape is a wide event, also called a canonical log line: one context-rich record for a request, command, provider turn, external process call, or service boundary.

OpenTelemetry, Effect tracing, and logger plumbing do not decide what context matters. The implementation agent still has to choose the useful business and operational context.

## Wide events

Prefer one wide event per meaningful service hop or operation boundary over many isolated strings. Build or enrich the event through the lifecycle and emit it once at completion, including failure paths. Middleware, an Effect layer, or another shared boundary should own timing, outcome capture, environment context, and final emission. Handlers and reactors should enrich that event with domain context.

Useful fields include:

- timestamp
- operation name
- outcome
- duration
- request, trace, thread, turn, provider, and provider instance IDs
- user-visible and domain identifiers needed to answer who or what was affected
- business or product context that explains impact
- feature flags or runtime choices that changed behavior
- service, version, commit, deployment, region, instance, or environment context when available
- external dependency latency and retry state
- structured error type, code, message, and retriable status

Propagate the request or trace ID across service boundaries so one query can reconstruct the operation. High-cardinality fields such as IDs, paths, request IDs, and trace IDs are valuable for debugging. Keep them on spans or log events where they are queryable. Do not put high-cardinality values on metric labels.

## Structure

Use the codebase's configured logger instead of creating a logger in each module or bypassing it with console output. Preserve one consistent schema and field name for each concept across services. Emit structured objects instead of burying queryable values in message strings.

Use existing middleware, layers, and request context before creating new logging infrastructure. A new abstraction earns its place only when the codebase lacks a boundary that can initialize, enrich, and emit the event reliably.

## T3 Code Effect pattern

In Effect code, use `Effect.annotateCurrentSpan` for queryable context and emit logs inside active spans with `Effect.logInfo`, `Effect.logWarning`, or `Effect.logError`. Logs inside an active span become trace events in the server observability pipeline.

Use logs to capture operational facts that tests cannot prove on their own:

- state transitions
- retry attempts and final retry outcome
- external boundary latency
- failure cause and classification
- fallback path selection
- queue, cache, provider, or process boundary behavior

Never log secrets, credentials, tokens, raw authorization headers, private keys, or full prompts.

## Sampling

If sampling is introduced, prefer tail sampling rules:

- Always keep errors.
- Always keep slow operations.
- Always keep flagged sessions, debug users, or rollout cohorts under investigation.
- Randomly sample only ordinary successful operations.

## Checklist

- Can one query answer what failed, for which thread or user-visible operation, where, and how long it took?
- Is the event structured and consistently named?
- Are important IDs present as fields instead of buried in message strings?
- Does the request or trace ID survive every service hop?
- Does a shared logger and lifecycle boundary own final emission?
- Does the event include the domain and deployment context needed to explain impact?
- Are high-cardinality debugging fields on spans or log events, not metric labels?
- Are secrets and full prompts excluded?
- Does the logging complement tests instead of replacing behavior-focused tests?
