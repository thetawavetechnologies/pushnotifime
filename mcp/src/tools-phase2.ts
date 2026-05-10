/**
 * Phase 2 tools: send, list_messages, list_groups, test.
 *
 * Each tool is a small pure-ish function that:
 *  - validates inputs
 *  - consumes a rate-limit token (for sends only)
 *  - calls the client
 *  - returns a JSON-serialisable result, or throws McpToolError
 */

import { McpToolError } from "./errors.js";
import { deriveIdempotencyKey } from "./idempotency.js";
import type { PushNotifiClient, SendBody } from "./client.js";
import type { Env } from "./env.js";
import type { RateLimiter } from "./rate-limit.js";

interface SendArgs {
  message: string;
  title?: string;
  send_to_key?: string;
  type?: "user" | "group";
  priority?: -2 | -1 | 0 | 1 | 2;
  url?: string;
  url_title?: string;
  idempotency_key?: string;
}

function asString(value: unknown, name: string, opts: { optional?: boolean; maxLen?: number } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (opts.optional) return undefined;
    throw new McpToolError("INVALID_ARG", `"${name}" is required`);
  }
  if (typeof value !== "string") {
    throw new McpToolError("INVALID_ARG", `"${name}" must be a string`);
  }
  if (value.length === 0) {
    throw new McpToolError("INVALID_ARG", `"${name}" must not be empty`);
  }
  if (opts.maxLen !== undefined && value.length > opts.maxLen) {
    throw new McpToolError("INVALID_ARG", `"${name}" exceeds max length ${opts.maxLen}`);
  }
  return value;
}

function asPriority(value: unknown): -2 | -1 | 0 | 1 | 2 | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new McpToolError("INVALID_ARG", '"priority" must be an integer in [-2, 2]');
  }
  if (value < -2 || value > 2) {
    throw new McpToolError("INVALID_ARG", `"priority" must be in [-2, 2], got ${value}`);
  }
  return value as -2 | -1 | 0 | 1 | 2;
}

function asType(value: unknown): "user" | "group" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value !== "user" && value !== "group") {
    throw new McpToolError("INVALID_ARG", '"type" must be "user" or "group"');
  }
  return value;
}

export function buildPhase2Tools(env: Env, client: PushNotifiClient, limiter: RateLimiter) {
  async function send(rawArgs: unknown): Promise<{ message: string; idempotency_key: string }> {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const message = asString(args.message, "message", { maxLen: 4096 })!;
    const title = asString(args.title, "title", { optional: true, maxLen: 256 });
    const explicitSendTo = asString(args.send_to_key, "send_to_key", { optional: true });
    const sendToKey = explicitSendTo ?? env.groupKey;
    if (sendToKey === null || sendToKey === undefined) {
      throw new McpToolError(
        "INVALID_ARG",
        '"send_to_key" is required because PUSHNOTIFI_GROUP_KEY is not set'
      );
    }
    const type = asType(args.type) ?? "group";
    const priority = asPriority(args.priority);
    const url = asString(args.url, "url", { optional: true, maxLen: 2048 });
    const urlTitle = asString(args.url_title, "url_title", { optional: true, maxLen: 256 });
    const explicitIdem = asString(args.idempotency_key, "idempotency_key", { optional: true, maxLen: 128 });

    const idempotencyKey =
      explicitIdem ??
      deriveIdempotencyKey("mcp", {
        type,
        send_to_key: sendToKey,
        message,
        title,
        priority,
        url,
        url_title: urlTitle,
      });

    limiter.consume();

    const body: SendBody = {
      type,
      send_to_key: sendToKey,
      message,
      idempotency_key: idempotencyKey,
    };
    if (title !== undefined) body.title = title;
    if (priority !== undefined) body.priority = priority;
    if (url !== undefined) body.url = url;
    if (urlTitle !== undefined) body.url_title = urlTitle;

    const result = await client.send(body);
    return { message: result.message, idempotency_key: idempotencyKey };
  }

  async function listMessages(): Promise<{ messages: unknown[] }> {
    const messages = await client.listMessages();
    return { messages };
  }

  async function listGroups(): Promise<{ groups: unknown[] }> {
    const groups = await client.listGroups();
    return { groups };
  }

  async function test(): Promise<{ message: string; idempotency_key: string }> {
    if (env.groupKey === null) {
      throw new McpToolError(
        "MISSING_ENV",
        "PUSHNOTIFI_GROUP_KEY is required for pushnotifi_test"
      );
    }
    const idempotencyKey = `mcp-test:${Math.floor(Date.now() / 1000)}`;
    limiter.consume();
    const result = await client.send({
      type: "group",
      send_to_key: env.groupKey,
      title: "Test from PushNotifi MCP",
      message: "PushNotifi MCP server is reachable.",
      priority: 0,
      idempotency_key: idempotencyKey,
    });
    return { message: result.message, idempotency_key: idempotencyKey };
  }

  return { send, listMessages, listGroups, test };
}
