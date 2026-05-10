/**
 * Phase 3 tools: request_ack, await_ack.
 *
 * Wires into the PushNotifi backend `alerts` surface:
 *   POST /api/v1/message              with `priority: 2`        → server mints `alert_id`
 *   POST /api/v1/alerts/:id/ack       (called by mobile app)    → records ack in `user_alert_ack`
 *   GET  /api/v1/alerts/:id/status                               → MCP polls for ack
 *
 * Binary ack is always valid. Phase 3b a1 adds an optional `response_template` (one of a
 * pre-registered set, see `alert-templates.ts`); when set, `await_ack` returns `response`
 * (the chosen template label, or free text for `freetext`) and optional `comment` for fixed-label notes.
 */

import { McpToolError, asError } from "./errors.js";
import type { Env } from "./env.js";
import type { PushNotifiClient } from "./client.js";
import type { RateLimiter } from "./rate-limit.js";
import {
  ALERT_RESPONSE_TEMPLATE_IDS,
  isAlertResponseTemplate,
} from "./alert-templates.js";

const POLL_INTERVAL_MS = 5_000;
/** Cap on Retry-After honored from server; protects against pathological values. */
const MAX_BACKOFF_MS = 60_000;

/**
 * Map a `send_to_key` to its `type`. PushNotifi keys are namespaced by their
 * first character: `u…` = user, `g…` = group. Anything else is invalid input
 * and should fail fast rather than silently mis-route the send.
 */
function inferSendType(sendToKey: string): "user" | "group" {
  const k = sendToKey.trim();
  if (k.startsWith("u")) return "user";
  if (k.startsWith("g")) return "group";
  throw new McpToolError(
    "INVALID_ARG",
    `"send_to_key" must start with "u" (user key) or "g" (group key); got "${k.slice(0, 8)}…"`
  );
}

/**
 * Decide whether a polling-loop error is transient (keep polling) or fatal
 * (surface to the agent). Returning `backoffMs` lets the loop honor a
 * server-supplied `Retry-After` on 429s instead of hammering the API.
 */
function classifyPollError(
  err: unknown
): { retry: false } | { retry: true; backoffMs: number | null } {
  if (!(err instanceof McpToolError)) return { retry: false };
  if (err.code === "NETWORK_ERROR") return { retry: true, backoffMs: null };
  if (err.code === "API_ERROR") {
    const details = err.details as { status?: unknown; retry_after_ms?: unknown };
    const status = typeof details.status === "number" ? details.status : 0;
    if (status === 429) {
      const ra =
        typeof details.retry_after_ms === "number" && details.retry_after_ms > 0
          ? Math.min(details.retry_after_ms, MAX_BACKOFF_MS)
          : null;
      return { retry: true, backoffMs: ra };
    }
    if (status === 502 || status === 503 || status === 504) {
      return { retry: true, backoffMs: null };
    }
  }
  return { retry: false };
}

interface AckResultAcked {
  acked: true;
  acked_at: string | null;
  acked_by_device_id: string | null;
  /** Phase 3b: chosen template label or free-text reply; null for binary acks. */
  response: string | null;
  /** Phase 3b: optional note with fixed-label templates; null when absent. */
  comment: string | null;
}
interface AckResultTimeout {
  acked: false;
  reason: "timeout";
}
type AckResult = AckResultAcked | AckResultTimeout;

function clampTimeout(value: unknown, env: Env): number {
  if (value === undefined || value === null) return env.defaultAckTimeoutSeconds;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new McpToolError("INVALID_ARG", '"timeout_seconds" must be a positive integer');
  }
  if (value > env.maxAckTimeoutSeconds) {
    throw new McpToolError(
      "INVALID_ARG",
      `"timeout_seconds" exceeds max ${env.maxAckTimeoutSeconds}s`
    );
  }
  return value;
}

export function buildPhase3Tools(env: Env, client: PushNotifiClient, limiter: RateLimiter) {
  async function requestAck(rawArgs: unknown): Promise<{ correlation_id: string }> {
    const args = (rawArgs ?? {}) as Record<string, unknown>;

    const message = args.message;
    if (typeof message !== "string" || message.length === 0) {
      throw new McpToolError("INVALID_ARG", '"message" is required');
    }
    if (message.length > 4096) {
      throw new McpToolError("INVALID_ARG", '"message" exceeds max length 4096');
    }

    const title =
      typeof args.title === "string" && args.title.length > 0 ? args.title : undefined;
    if (title !== undefined && title.length > 256) {
      throw new McpToolError("INVALID_ARG", '"title" exceeds max length 256');
    }

    const explicitSendTo =
      typeof args.send_to_key === "string" && args.send_to_key.length > 0
        ? args.send_to_key
        : null;
    const sendToKey = explicitSendTo ?? env.groupKey;
    if (sendToKey === null) {
      throw new McpToolError(
        "INVALID_ARG",
        '"send_to_key" is required because PUSHNOTIFI_GROUP_KEY is not set'
      );
    }

    const templateRaw = args.response_template;
    let template: ReturnType<typeof asTemplate> | undefined;
    if (templateRaw !== undefined && templateRaw !== null) {
      template = asTemplate(templateRaw);
    }

    const sendType = inferSendType(sendToKey);

    limiter.consume();

    const sendBody: Parameters<PushNotifiClient["send"]>[0] = {
      type: sendType,
      send_to_key: sendToKey,
      message,
      title,
      priority: 2,
    };
    if (template !== undefined) {
      sendBody.alert_response_template = template;
    }

    const result = await client.send(sendBody);

    if (typeof result.alert_id !== "string" || result.alert_id.length === 0) {
      throw new McpToolError(
        "API_ERROR",
        "Server did not return an alert_id for a priority-2 send. The backend may not yet be on the version that exposes alert_id in the send response.",
        { send_response: result }
      );
    }

    return { correlation_id: result.alert_id };
  }

  async function awaitAck(rawArgs: unknown): Promise<AckResult> {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const correlationId = args.correlation_id;
    if (typeof correlationId !== "string" || correlationId.length === 0) {
      throw new McpToolError("INVALID_ARG", '"correlation_id" is required');
    }
    const timeoutSeconds = clampTimeout(args.timeout_seconds, env);
    const deadlineMs = Date.now() + timeoutSeconds * 1000;

    while (Date.now() < deadlineMs) {
      let status;
      try {
        status = await client.getAlertStatus(correlationId);
      } catch (err) {
        const verdict = classifyPollError(err);
        if (!verdict.retry) {
          if (err instanceof McpToolError) throw err;
          throw new McpToolError(
            "NETWORK_ERROR",
            `Ack poll failed: ${asError(err).message}`
          );
        }
        const remaining = deadlineMs - Date.now();
        if (remaining <= 0) break;
        const backoffMs = verdict.backoffMs ?? POLL_INTERVAL_MS;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(backoffMs, remaining))
        );
        continue;
      }
      if (status.acked === true) {
        return {
          acked: true,
          acked_at: status.acked_at,
          acked_by_device_id: status.acked_by_device_id,
          response: status.response ?? null,
          comment: status.comment ?? null,
        };
      }
      const remaining = deadlineMs - Date.now();
      if (remaining <= 0) break;
      const sleepMs = Math.min(POLL_INTERVAL_MS, remaining);
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
    }

    return { acked: false, reason: "timeout" };
  }

  return { requestAck, awaitAck };
}

function asTemplate(raw: unknown) {
  if (isAlertResponseTemplate(raw)) {
    return raw;
  }
  throw new McpToolError(
    "INVALID_ARG",
    `"response_template" must be one of: ${ALERT_RESPONSE_TEMPLATE_IDS.join(", ")}`
  );
}
