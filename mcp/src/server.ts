#!/usr/bin/env node
/**
 * PushNotifi MCP server.
 *
 * Stdio transport. Reads credentials from environment ONCE at startup.
 * Hard rules:
 *   - No tool argument may carry an API key (env-only).
 *   - Outbound sends are token-bucket rate-limited (default 30/min).
 *   - Idempotency keys are auto-derived from a canonical args hash.
 *   - Every failure path returns a typed `{ code, message, details }` payload.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadEnv, redactKey } from "./env.js";
import { createClient } from "./client.js";
import { createRateLimiter } from "./rate-limit.js";
import { buildPhase2Tools } from "./tools-phase2.js";
import { buildPhase3Tools } from "./tools-phase3.js";
import { McpToolError, asError } from "./errors.js";

const SERVER_NAME = "pushnotifi";
const SERVER_VERSION = "0.4.0";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: unknown) => Promise<unknown>;
}

function buildTools(): ToolDef[] {
  const env = loadEnv();
  const client = createClient(env);
  const limiter = createRateLimiter(env.rateLimitPerMinute);
  const p2 = buildPhase2Tools(env, client, limiter);
  const p3 = buildPhase3Tools(env, client, limiter);

  const sendTool: ToolDef = {
    name: "pushnotifi_send",
    description:
      "Send a push notification via PushNotifi. Reads API key from server env, never from arguments. " +
      "If `idempotency_key` is omitted it is derived from the args hash so transport retries do not duplicate.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "Notification body (required)", maxLength: 4096 },
        title: { type: "string", description: "Short title", maxLength: 256 },
        send_to_key: {
          type: "string",
          description: "Target key (`u…` or `g…`). Defaults to PUSHNOTIFI_GROUP_KEY env.",
        },
        type: { type: "string", enum: ["user", "group"], default: "group" },
        priority: { type: "integer", minimum: -2, maximum: 2, default: 0 },
        url: { type: "string", maxLength: 2048 },
        url_title: { type: "string", maxLength: 256 },
        idempotency_key: { type: "string", maxLength: 128 },
      },
      required: ["message"],
      additionalProperties: false,
    },
    handler: p2.send,
  };

  const listMessagesTool: ToolDef = {
    name: "pushnotifi_list_messages",
    description: "List recent outbound messages for the authenticated PushNotifi account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => p2.listMessages(),
  };

  const listGroupsTool: ToolDef = {
    name: "pushnotifi_list_groups",
    description: "List groups available to the authenticated PushNotifi account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => p2.listGroups(),
  };

  const testTool: ToolDef = {
    name: "pushnotifi_test",
    description:
      "Send a fixed smoke-test notification to the configured group. Use to confirm the MCP server, " +
      "credentials, and device delivery are healthy before relying on the agent's own sends.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: () => p2.test(),
  };

  const requestAckTool: ToolDef = {
    name: "pushnotifi_request_ack",
    description:
      "Pause your workflow on a decision a human must make. Sends a push notification to the user's " +
      "phone (PushNotifi mobile app) and returns a correlation_id you pass to pushnotifi_await_ack to " +
      "block until they decide. Use for: production-write approvals, ambiguous decisions the agent " +
      "should not make alone, cost-sensitive actions, security-sensitive actions, escalations. " +
      "Optional response_template renders a pre-registered button set " +
      "(ack | yes_no | approve_deny | proceed_abort | confirm_cancel) or 'freetext' for a typed reply " +
      "on the message detail screen. For fixed-label templates the user can add an optional " +
      "comment under the buttons; it is returned separately from `response` " +
      "(the chosen label) by pushnotifi_await_ack. Without response_template the alert is binary acknowledge " +
      "only. Always phrase prompts so the safe default is *not* tapping when uncertain — the timeout MUST mean abort.",
    inputSchema: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to ask the user", maxLength: 4096 },
        title: { type: "string", maxLength: 256 },
        send_to_key: {
          type: "string",
          description:
            "Defaults to PUSHNOTIFI_GROUP_KEY env. Must start with `g` (group key) or `u` (user key); " +
            "the send `type` is inferred from the prefix. Always sent at emergency priority " +
            "since only emergency sends are server-tracked for ack.",
        },
        response_template: {
          type: "string",
          enum: ["ack", "yes_no", "approve_deny", "proceed_abort", "confirm_cancel", "freetext"],
          description:
            "Phase 3b a1: pre-registered response UX. Labels are fixed: ack=[Acknowledge], yes_no=[Yes,No], " +
            "approve_deny=[Approve,Deny], proceed_abort=[Proceed,Abort], confirm_cancel=[Confirm,Cancel], " +
            "freetext=user types on detail screen. Returned by pushnotifi_await_ack as `response` " +
            "(exact label or freetext). Optional `comment` when the user adds a note under fixed-label buttons " +
            "(≤1024 chars). Omit for legacy binary acknowledge.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    handler: p3.requestAck,
  };

  const awaitAckTool: ToolDef = {
    name: "pushnotifi_await_ack",
    description:
      "Block until a previously-issued correlation_id is acknowledged, or the timeout fires. " +
      "Polls GET /api/v1/alerts/:alert_id/status every 5s. Returns " +
      "{ acked: true, acked_at, acked_by_device_id, response, comment } on ack. " +
      "`response` shape: null for legacy binary acks; the typed string for `freetext`; the exact " +
      "template label (e.g. `\"Approve\"`) for fixed templates. `comment` is non-null when the user added an optional " +
      "note alongside a fixed-label choice. Or { acked: false, reason: 'timeout' }.",
    inputSchema: {
      type: "object",
      properties: {
        correlation_id: {
          type: "string",
          description: "The alert_id returned by pushnotifi_request_ack.",
        },
        timeout_seconds: {
          type: "integer",
          minimum: 1,
          default: 900,
          description: "Hard cap 3600s (1h). Default 900s (15 min).",
        },
      },
      required: ["correlation_id"],
      additionalProperties: false,
    },
    handler: p3.awaitAck,
  };

  return [sendTool, listMessagesTool, listGroupsTool, testTool, requestAckTool, awaitAckTool];
}

async function main(): Promise<void> {
  let tools: ToolDef[];
  try {
    tools = buildTools();
  } catch (err) {
    process.stderr.write(`[pushnotifi-mcp] startup failed: ${asError(err).message}\n`);
    process.exit(1);
  }

  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const env = loadEnv();
  process.stderr.write(
    `[pushnotifi-mcp] starting (api=${env.apiBaseUrl}, key=${redactKey(env.userKey)}, ` +
      `rate_limit=${env.rateLimitPerMinute}/min)\n`
  );

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = toolByName.get(name);
    if (tool === undefined) {
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ code: "INVALID_ARG", message: `Unknown tool: ${name}` }) }],
      };
    }
    try {
      const result = await tool.handler(req.params.arguments);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (err) {
      const payload =
        err instanceof McpToolError
          ? err.toToolPayload()
          : { code: "API_ERROR", message: asError(err).message };
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload) }],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("[pushnotifi-mcp] ready\n");
}

main().catch((err) => {
  process.stderr.write(`[pushnotifi-mcp] fatal: ${asError(err).message}\n`);
  process.exit(1);
});
