import * as Schema from "effect/Schema";
import type * as SchemaIssue from "effect/SchemaIssue";

import * as AcpSchema from "./_generated/schema.gen.ts";

export const AcpRequestOperation = Schema.Literals([
  "decode-extension-request-payload",
  "encode-extension-response",
  "handle-request",
  "handle-extension-request",
  "receive-response",
  "receive-streaming-response",
]);
export type AcpRequestOperation = typeof AcpRequestOperation.Type;

export const AcpSchemaTicketKind = Schema.Literals([
  "Filter",
  "Encoding",
  "Pointer",
  "Composite",
  "AnyOf",
  "InvalidType",
  "InvalidValue",
  "MissingKey",
  "UnexpectedKey",
  "Forbidden",
  "OneOf",
]);
export type AcpSchemaTicketKind = typeof AcpSchemaTicketKind.Type;

export interface AcpSchemaTicketDiagnostics {
  readonly ticketCount: number;
  readonly ticketKinds: ReadonlyArray<AcpSchemaTicketKind>;
  readonly maximumPathDepth: number;
}

const schemaTicketDiagnostics = (root: SchemaIssue.Issue): AcpSchemaTicketDiagnostics => {
  let ticketCount = 0;
  let maximumPathDepth = 0;
  const ticketKinds = new Set<AcpSchemaTicketKind>();

  const visit = (ticket: SchemaIssue.Issue, pathDepth: number): void => {
    ticketCount += 1;
    ticketKinds.add(ticket._tag);
    maximumPathDepth = Math.max(maximumPathDepth, pathDepth);
    switch (ticket._tag) {
      case "Filter":
      case "Encoding":
        visit(ticket.issue, pathDepth);
        break;
      case "Pointer":
        visit(ticket.issue, pathDepth + ticket.path.length);
        break;
      case "Composite":
      case "AnyOf":
        for (const child of ticket.issues) visit(child, pathDepth);
        break;
    }
  };

  visit(root, 0);
  return {
    ticketCount,
    ticketKinds: [...ticketKinds],
    maximumPathDepth,
  };
};

export interface AcpRequestDiagnostics {
  readonly method?: string;
  readonly requestId?: string;
  readonly operation?: AcpRequestOperation;
  readonly cause?: unknown;
  readonly ticketCount?: number;
  readonly ticketKinds?: ReadonlyArray<AcpSchemaTicketKind>;
  readonly maximumPathDepth?: number;
}

export class AcpSpawnError extends Schema.TaggedErrorClass<AcpSpawnError>()("AcpSpawnError", {
  command: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message() {
    return this.command
      ? `Failed to spawn ACP process for command: ${this.command}`
      : "Failed to spawn ACP process";
  }
}

export class AcpProcessExitedError extends Schema.TaggedErrorClass<AcpProcessExitedError>()(
  "AcpProcessExitedError",
  {
    code: Schema.optional(Schema.Number),
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.code === undefined
      ? "ACP process exited"
      : `ACP process exited with code ${this.code}`;
  }
}

export const AcpProtocolParseOperation = Schema.Literals([
  "encode-message",
  "decode-wire-message",
  "decode-notification-payload",
]);
export type AcpProtocolParseOperation = typeof AcpProtocolParseOperation.Type;

export class AcpProtocolParseError extends Schema.TaggedErrorClass<AcpProtocolParseError>()(
  "AcpProtocolParseError",
  {
    operation: AcpProtocolParseOperation,
    method: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    ticketCount: Schema.optionalKey(Schema.Number),
    ticketKinds: Schema.optionalKey(Schema.Array(AcpSchemaTicketKind)),
    maximumPathDepth: Schema.optionalKey(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const method = this.method === undefined ? "" : ` for method '${this.method}'`;
    return `ACP protocol operation '${this.operation}' failed${method}.`;
  }

  static fromSchemaError(
    operation: AcpProtocolParseOperation,
    method: string,
    cause: Schema.SchemaError,
  ) {
    return new AcpProtocolParseError({
      operation,
      method,
      ...schemaTicketDiagnostics(cause.issue),
      cause,
    });
  }

  static fromEncodingError(
    method: string | undefined,
    requestId: string | undefined,
    cause: unknown,
  ) {
    return new AcpProtocolParseError({
      operation: "encode-message",
      ...(method === undefined ? {} : { method }),
      ...(requestId === undefined ? {} : { requestId }),
      cause,
    });
  }
}

export class AcpTransportError extends Schema.TaggedErrorClass<AcpTransportError>()(
  "AcpTransportError",
  {
    operation: Schema.optional(
      Schema.Literals(["call-rpc", "read-input-stream", "read-process-exit-status"]),
    ),
    method: Schema.optional(Schema.String),
    detail: Schema.optional(Schema.String),
    pid: Schema.optionalKey(Schema.Int),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    const method = this.method ? ` for method ${this.method}` : "";
    return this.operation
      ? `ACP transport operation ${this.operation} failed${method}.`
      : "ACP transport operation failed.";
  }
}

export class AcpInputStreamEndedError extends Schema.TaggedErrorClass<AcpInputStreamEndedError>()(
  "AcpInputStreamEndedError",
  {},
) {
  override get message() {
    return "ACP input stream ended.";
  }
}

export class AcpRequestError extends Schema.TaggedErrorClass<AcpRequestError>()("AcpRequestError", {
  code: AcpSchema.ErrorCode,
  errorMessage: Schema.String,
  data: Schema.optional(Schema.Unknown),
  method: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  operation: Schema.optionalKey(AcpRequestOperation),
  ticketCount: Schema.optionalKey(Schema.Number),
  ticketKinds: Schema.optionalKey(Schema.Array(AcpSchemaTicketKind)),
  maximumPathDepth: Schema.optionalKey(Schema.Number),
  cause: Schema.optionalKey(Schema.Defect()),
}) {
  override get message() {
    return this.errorMessage;
  }

  static fromProtocolError(
    error: AcpSchema.Error,
    context: {
      readonly method: string;
      readonly requestId?: string;
      readonly cause?: unknown;
    },
  ) {
    return new AcpRequestError({
      code: error.code,
      errorMessage: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
      method: context.method,
      ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
      operation: "receive-response",
      cause: context.cause ?? error,
    });
  }

  static fromExtensionResponseFailure(method: string, requestId: string, cause: unknown) {
    return AcpRequestError.internalError("Extension request failed", undefined, {
      method,
      requestId,
      operation: "receive-response",
      cause,
    });
  }

  static fromExtensionResponseEncodingError(
    method: string,
    requestId: string,
    cause: AcpProtocolParseError,
  ) {
    return AcpRequestError.internalError("Internal error", undefined, {
      method,
      requestId,
      operation: "encode-extension-response",
      cause,
    });
  }

  static unsupportedStreamingResponse(method: string, requestId: string) {
    return AcpRequestError.internalError(
      "Streaming extension responses are not supported",
      undefined,
      {
        method,
        requestId,
        operation: "receive-streaming-response",
      },
    );
  }

  static fromCoreHandlerError(error: AcpError, method: string) {
    if (error._tag === "AcpRequestError") {
      return error;
    }
    return AcpRequestError.internalError(
      `ACP request handler failed for method '${method}'`,
      undefined,
      {
        method,
        operation: "handle-request",
        cause: error,
      },
    );
  }

  static fromExtensionHandlerError(error: AcpError, method: string) {
    if (error._tag === "AcpRequestError") {
      return error;
    }
    return AcpRequestError.internalError(
      `ACP extension request handler failed for method '${method}'`,
      undefined,
      {
        method,
        operation: "handle-extension-request",
        cause: error,
      },
    );
  }

  static parseError(message = "Parse error", data?: unknown) {
    return new AcpRequestError({
      code: -32700,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static invalidRequest(message = "Invalid request", data?: unknown) {
    return new AcpRequestError({
      code: -32600,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static methodNotFound(method: string) {
    return new AcpRequestError({
      code: -32601,
      errorMessage: `Method not found: ${method}`,
    });
  }

  static invalidParams(message = "Invalid params", data?: unknown) {
    return new AcpRequestError({
      code: -32602,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static invalidExtensionPayload(method: string, cause: Schema.SchemaError) {
    const diagnostics = schemaTicketDiagnostics(cause.issue);
    return new AcpRequestError({
      code: -32602,
      errorMessage: `Invalid payload for ACP extension method '${method}'.`,
      data: diagnostics,
      method,
      operation: "decode-extension-request-payload",
      ...diagnostics,
      cause,
    });
  }

  static internalError(
    message = "Internal error",
    data?: unknown,
    diagnostics: AcpRequestDiagnostics = {},
  ) {
    return new AcpRequestError({
      code: -32603,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
      ...diagnostics,
    });
  }

  static authRequired(message = "Authentication required", data?: unknown) {
    return new AcpRequestError({
      code: -32000,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  static resourceNotFound(message = "Resource not found", data?: unknown) {
    return new AcpRequestError({
      code: -32002,
      errorMessage: message,
      ...(data !== undefined ? { data } : {}),
    });
  }

  toProtocolError() {
    return AcpSchema.Error.make({
      code: this.code,
      message: this.errorMessage,
      ...(this.data !== undefined ? { data: this.data } : {}),
    });
  }
}

export const AcpError = Schema.Union([
  AcpRequestError,
  AcpSpawnError,
  AcpProcessExitedError,
  AcpProtocolParseError,
  AcpTransportError,
  AcpInputStreamEndedError,
]);

export type AcpError = typeof AcpError.Type;
