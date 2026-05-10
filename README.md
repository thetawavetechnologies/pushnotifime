# PushNotifi — human-in-the-loop for AI agents, on your phone

Your AI agent (Cursor, Claude Code, any MCP-aware client) reaches a decision it
shouldn't make alone. It calls `pushnotifi_request_ack`. You get a push on the
PushNotifi mobile app. You tap **Approve / Deny / Yes / No / Proceed / Abort**
or type a free-text reply. The agent's `pushnotifi_await_ack` call returns your
answer, and the workflow continues — or times out and aborts when you don't
respond.

Backed by [PushNotifi.me](https://pushnotifi.me).

## When to use it

- Production-write approvals (`terraform apply`, schema migrations, refunds, deletes).
- Cost-sensitive actions (LLM spend over a threshold, paid-API jobs, infra resizing).
- Security-sensitive actions (key rotation, access grants, privileged shell commands).
- Ambiguous decisions where the agent should ask, not guess.
- Long-running autonomous jobs that need a human checkpoint.

The agent stays asynchronous; the human is reachable wherever they are.

## What ships

### Approval-layer primitive — Phase 3 (LIVE)

Two MCP tools wired against the PushNotifi `alerts` surface:

- **`pushnotifi_request_ack(message, title?, send_to_key?, response_template?)`** —
  sends an emergency-priority notification, returns the server-minted `alert_id`
  as `correlation_id`. Optional `response_template` renders one of six
  pre-registered button sets on the user's phone:

  | `response_template` | Buttons on phone |
  | ------------------- | ---------------- |
  | omitted / `ack`     | `Acknowledge` |
  | `yes_no`            | `Yes` / `No` |
  | `approve_deny`      | `Approve` / `Deny` |
  | `proceed_abort`     | `Proceed` / `Abort` |
  | `confirm_cancel`    | `Confirm` / `Cancel` |
  | `freetext`          | multi-line text reply on the message-detail screen |

- **`pushnotifi_await_ack(correlation_id, timeout_seconds?)`** —
  polls `GET /alerts/:alert_id/status` every 5s and returns
  `{ acked: true, acked_at, acked_by_device_id, response }` on ack
  (`response` is the chosen label or typed text, or `null` for binary acks),
  or `{ acked: false, reason: 'timeout' }`.

Server validates `response` against the originating message's stored snapshot
(no forged labels). Local repeat suppression always runs first so the alarm
stops on the user's device even if the network ack POST fails.

**Safety property the agent must respect:** the user may simply dismiss an
alarm rather than approve. Phrase the prompt so the only sensible reason to
tap is to approve, the safe default is *not* tapping, and `timeout_seconds`
is short enough (≤ 300s for production-write actions) that an inattentive
user does not implicitly authorize.

See [`docs/phase-3-backend-spec.md`](docs/phase-3-backend-spec.md) for the
full backend contract, snapshot validation rules, and the deferred 3b.2
tray-button work.

### Operational tools — Phase 2 MCP server (`mcp/`)

Stdio MCP server exposing PushNotifi as additional tool calls:

- `pushnotifi_send` — `POST /api/v1/message` with auto-derived `idempotency_key`.
- `pushnotifi_list_messages` — `GET /api/v1/messages`.
- `pushnotifi_list_groups` — `GET /api/v1/groups`.
- `pushnotifi_test` — fixed-payload smoke test.

Hard safety properties (see `ANALYSIS.md` §8 for rationale):

1. The API key is read from env at startup. **Never accepted as a tool argument.**
2. Client-side token-bucket rate limit (default 30 sends/min, override via
   `PUSHNOTIFI_RATE_LIMIT_PER_MINUTE`).
3. Idempotency keys auto-derived from canonical args hash when the caller omits one.
4. Every failure is a typed `{ code, message, details }` payload — no silent swallow.

Build the server before first use:

```bash
cd mcp
npm install
npm run build
```

`mcp.json` at the plugin root wires the built server into Cursor.

### Developer scaffolding — Phase 1

- **Skills** — code generation for Node, Python, Go, shell, Next.js, Express.
  - `pushnotifi-scaffold` — the canonical `POST /api/v1/message` contract,
    idempotency, typed errors.
  - `pushnotifi-recipes` — opinionated patterns for failed cron jobs, webhook
    signature mismatches, DB migration failures, error-rate thresholds.
- **Rules** — auto-attached guardrails.
  - `pushnotifi-secrets` — forbid hardcoded keys; require env vars; never log values.
  - `webhook-resilience` — every inbound webhook handler must catch errors and
    alert with a stable `idempotency_key`.
- **Commands**
  - `/pushnotifi init` — install the SDK, write `.env.example`, update `.gitignore`.
  - `/pushnotifi test` — send a single test push to confirm credentials and delivery.

## Quick start

1. Install the plugin in Cursor.
2. In a Node project, run `/pushnotifi init`.
3. Open [pushnotifi.me/dashboard](https://pushnotifi.me/dashboard), copy your
   API key into `PUSHNOTIFI_USER_KEY` and a group's `g…` key into
   `PUSHNOTIFI_GROUP_KEY` (both in your local `.env`).
4. Run `/pushnotifi test`. A push should land on the PushNotifi mobile app
   within a few seconds.
5. To enable the MCP server, build it (`cd mcp && npm install && npm run build`)
   and set `PUSHNOTIFI_USER_KEY` / `PUSHNOTIFI_GROUP_KEY` in the environment
   Cursor uses to launch MCP servers.

## Environment variables

| Variable                              | Required                            | Notes |
| ------------------------------------- | ----------------------------------- | ----- |
| `PUSHNOTIFI_USER_KEY`                 | yes                                 | Account API key (`X-API-Key`) |
| `PUSHNOTIFI_GROUP_KEY`                | yes for `/test` and default sends   | Group `send_to_key` (`g…`, 32 chars) |
| `PUSHNOTIFI_APPLICATION_KEY`          | no                                  | Omit to use account default application |
| `PUSHNOTIFI_WEBHOOK_TOKEN`            | no                                  | Per-user inbound-webhook token (CI recipe) |
| `PUSHNOTIFI_API_BASE_URL`             | no                                  | Default `https://api.pushnotifi.me` |
| `PUSHNOTIFI_RATE_LIMIT_PER_MINUTE`    | no                                  | MCP server rate limit, default `30` |

## Roadmap (not in 0.4.0)

- **Native tray-button actions** (iOS pre-registered `UNNotificationCategory`s,
  Android per-notification actions) — same wire format, mobile-only work.
  Today the user opens the message-detail screen to choose; tray buttons will
  let them tap directly from the notification.
- **Escalation chains, multi-recipient approvals, push-on-ack webhook** —
  agents currently chain `request_ack` calls themselves and poll
  `await_ack`. Native server support is on the roadmap but not promised here.

## Scope

Operational tooling for developers building agentic workflows — approvals,
escalations, ambiguity routing, error alerts. Not the right tool for end-user
product notifications inside a consumer app.

## Validate

```bash
node scripts/validate-template.mjs
```

Must print `Validation passed.` before submitting to the marketplace. Warnings
about missing files in unused folders are fine.

## License

MIT.
