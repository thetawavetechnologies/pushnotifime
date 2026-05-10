/**
 * Thin HTTP client for the PushNotifi REST API.
 *
 * Wraps `fetch` because the published `pushnotifime` SDK does not yet expose
 * the Phase 3 ack endpoints; using one client for everything keeps error
 * handling and header injection consistent.
 */

import { McpToolError, asError } from "./errors.js";
import type { Env } from "./env.js";

import type { AlertResponseTemplate } from "./alert-templates.js";

export interface SendBody {
  type: "user" | "group";
  send_to_key: string;
  message: string;
  title?: string;
  priority?: -2 | -1 | 0 | 1 | 2;
  application_key?: string;
  url?: string;
  url_title?: string;
  ttl?: number;
  idempotency_key?: string;
  /** Phase 3b a1: pre-registered response template id; only valid with `priority: 2`. */
  alert_response_template?: AlertResponseTemplate;
}

export interface SendResponse {
  message: string;
  /** Server-minted on `priority: 2` sends; used as the ack correlation id. */
  alert_id?: string;
}

export interface AlertStatusResponse {
  alert_id: string;
  acked: boolean;
  acked_at: string | null;
  acked_by_device_id: string | null;
  /** Phase 3b: chosen option label or free-text reply; null when absent or pre-3b ack. */
  response: string | null;
  /** Phase 3b: optional note with fixed-label templates; null when absent. */
  comment: string | null;
}

export interface PushNotifiClient {
  send(body: SendBody): Promise<SendResponse>;
  listMessages(): Promise<unknown[]>;
  listGroups(): Promise<unknown[]>;
  getAlertStatus(alertId: string): Promise<AlertStatusResponse>;
}

const REQUEST_TIMEOUT_MS = 10_000;

export function createClient(env: Env): PushNotifiClient {
  const apiRoot = `${env.apiBaseUrl}/api/v1`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-API-Key": env.userKey,
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${apiRoot}${path.startsWith("/") ? path : `/${path}`}`;
    const reqHeaders: Record<string, string> = { ...headers };
    let payload: string | undefined;
    if (body !== undefined) {
      reqHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: reqHeaders,
        body: payload,
        signal: controller.signal,
      });
    } catch (err) {
      const e = asError(err);
      if (e.name === "AbortError") {
        throw new McpToolError("NETWORK_ERROR", `Request to ${path} timed out after ${REQUEST_TIMEOUT_MS}ms`);
      }
      throw new McpToolError("NETWORK_ERROR", `Request to ${path} failed: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
    }

    if (!res.ok) {
      throw new McpToolError("API_ERROR", `PushNotifi API ${res.status} on ${method} ${path}`, {
        status: res.status,
        body: parsed,
      });
    }

    return parsed as T;
  }

  return {
    send(body) {
      const merged: SendBody = { ...body };
      if (merged.application_key === undefined && env.applicationKey !== null) {
        merged.application_key = env.applicationKey;
      }
      return request<SendResponse>("POST", "/message", merged);
    },
    listMessages() {
      return request<unknown[]>("GET", "/messages");
    },
    listGroups() {
      return request<unknown[]>("GET", "/groups");
    },
    getAlertStatus(alertId) {
      const trimmed = alertId.trim();
      if (trimmed.length === 0) {
        throw new McpToolError("INVALID_ARG", "alert_id is required");
      }
      if (trimmed.length > 64) {
        throw new McpToolError("INVALID_ARG", "alert_id must be <= 64 characters");
      }
      return request<AlertStatusResponse>("GET", `/alerts/${encodeURIComponent(trimmed)}/status`);
    },
  };
}
