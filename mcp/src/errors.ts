/**
 * Typed errors for the MCP server. Every failure path returns one of these.
 * The dispatch layer converts them into MCP `isError: true` content blocks
 * so the calling agent can branch on `code`.
 */

export type ErrorCode =
  | "MISSING_ENV"
  | "INVALID_ARG"
  | "RATE_LIMITED"
  | "API_ERROR"
  | "NETWORK_ERROR"
  | "TIMEOUT";

export class McpToolError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.details = details;
  }

  toToolPayload(): { code: ErrorCode; message: string; details: Record<string, unknown> } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function asError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === "string" ? value : JSON.stringify(value));
}
