# Changelog

All notable changes to the PushNotifi Cursor plugin will be documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — backend (`pushnotifi/api`)

- Optional comment under fixed-label templates is stored in **`user_alert_ack.comment`**
  (`TEXT NULL`), not concatenated into `response`. `POST /alerts/:id/ack` accepts optional
  `comment` alongside `response`. Validation: `validateAckAgainstSnapshot` (`api/src/utils/alertResponseTemplate.ts`).
  Legacy clients may still send `"<Label>\n\n<note>"` **only** in `response` when `comment` is omitted;
  the server splits that into label + stored comment.
- Migration `web/src/db/migrations/067_user_alert_ack_comment.sql`. **Apply before deploy**
  (after `066_user_alert_ack_response.sql`).

### Added — mobile-app

- Message detail screen sends optional notes as the JSON **`comment`** field with fixed-label
  buttons; `response` is only the chosen label.

### Added — MCP

- `pushnotifi_await_ack` returns **`comment: string | null`** from `GET .../status` in addition to `response`.
- Tool descriptions and `mcp/src/alert-templates.ts` document the two-field contract.

### Fixed — MCP

- `pushnotifi_request_ack` now infers `type` from the `send_to_key` prefix
  (`u…` → `user`, `g…` → `group`) instead of hardcoding `type: "group"`,
  which previously misrouted user-targeted asks. Invalid prefixes fail fast
  with `INVALID_ARG`.

### Changed — MCP (resilience)

- `pushnotifi_await_ack` polling loop now treats `429`, `502`, `503`, `504`,
  and network errors as transient and continues polling within the deadline
  instead of failing the whole call. `Retry-After` on `429` is honored
  (capped at 60 s); other 4xx errors still fail fast.

### Documentation

- `docs/phase-3-backend-spec.md` updated for the separate `comment` column and wire field.
- Removed stale references to a non-existent `ANALYSIS.md` from
  `README.md` and `mcp/src/server.ts`; safety properties are now listed
  inline in the README.
- `pushnotifi_request_ack` `send_to_key` description no longer references a
  non-existent `priority` arg.

## [0.4.0] — Phase 3b a1: pre-registered response templates

Approval-layer primitive completed end-to-end. Agents can now ask for a typed
human decision (yes/no, approve/deny, proceed/abort, confirm/cancel) or a
free-text reply, and the chosen label is returned via `pushnotifi_await_ack`.

Positioning sharpened: the plugin is now described as
**human-in-the-loop for AI agents on your phone** rather than a generic
push-notification utility. Marketplace, README, package descriptions, and the
`pushnotifi_request_ack` tool description all updated.

### Added — backend (`pushnotifi/api`, `pushnotifi/jobs`)

- `POST /api/v1/message` accepts optional `alert_response_template`
  (`ack | yes_no | approve_deny | proceed_abort | confirm_cancel | freetext`);
  persisted to `messages.extra` and propagated as
  `data.alert_response_template` on the FCM push.
- `POST /api/v1/alerts/:alert_id/ack` accepts optional `response: string`;
  validated server-side against the originating message snapshot
  (`validateAckResponseAgainstSnapshot`) so forged labels are rejected.
- `GET /api/v1/alerts/:alert_id/status` now returns `response: string | null`.
- Migration `web/src/db/migrations/066_user_alert_ack_response.sql` adds
  `user_alert_ack.response TEXT NULL`. **Must be applied before deploy.**
- Jobs consumer (`jobs/src/pushSendExecutor.ts`) mirrors the API normalization
  via `jobs/src/alertResponseTemplate.ts` so JetStream-dispatched sends apply
  identical validation.

### Added — MCP

- `pushnotifi_request_ack` accepts `response_template`:
  `ack | yes_no | approve_deny | proceed_abort | confirm_cancel | freetext`.
- `pushnotifi_await_ack` returns `response: string | null` on ack — the
  chosen template label or free-text reply, or `null` for binary acks.
- Shared template enum in `mcp/src/alert-templates.ts` mirrors the server
  source of truth (`api/src/utils/alertResponseTemplate.ts`).
- Tool descriptions reframed around the human-in-the-loop use case so
  agents pick `request_ack` for the right reasons (approvals, ambiguous
  decisions, cost-/security-sensitive actions).

### Added — mobile-app

- Message detail screen renders the right control per template: binary
  button (legacy / `ack`), fixed-label buttons (yes/no, approve/deny, …),
  or free-text `TextField` + Submit (`freetext`).
- `acknowledgeEmergencyAlertById(alertId, response: ...)` posts the
  user's chosen label / typed text alongside `device_id`. Local repeat
  suppression still runs **before** the network call so the alarm stops
  on this device even if the POST fails.
- `PushMessage.alertResponseTemplate` parsed from API row + FCM extra.
- Single source of truth for templates →
  `mobile-app/lib/utils/alert_response_template.dart` (must stay in sync
  with API / jobs / MCP — guarded by acceptance tests in the spec).
- Backwards-compatible: payloads without a template fall back to 3a binary
  acknowledge. Old app versions ignore the new field; the server treats
  their empty `response` as a valid binary ack.

### Documentation

- `docs/phase-3-backend-spec.md` §2 fully rewritten for the template
  design. New §2.8 records the rationale for choosing pre-registered
  templates over agent-supplied freeform option labels (iOS does not
  allow per-notification action title overrides).

### Roadmap (NOT in 0.4.0)

- Native tray-button actions (iOS pre-registered `UNNotificationCategory`s
  + Android per-notification actions). Same wire format already shipped;
  mobile-only work. See `docs/phase-3-backend-spec.md` §2.6.
- Escalation chains, multi-recipient approvals (first-reply-wins / quorum),
  push-on-ack webhook to the agent. All currently agent-side patterns;
  server-side support remains out of scope.

## [0.3.0] — Phase 3a (binary acknowledge) shipped

### Added — backend (`pushnotifi/api`)

- `GET /api/v1/alerts/:alert_id/status` — read-only ack lookup, scoped to the authenticated account, returns `{ alert_id, acked, acked_at, acked_by_device_id }`. (`routes.ts`, `controller.ts`, `services.ts`, `models/model.ts`)
- `POST /api/v1/message` response now includes `alert_id` for `priority: 2` (emergency) sends. Backwards-compatible — field omitted for non-emergency sends.

No DB migration required; the existing `user_alert_ack` table is the source of truth.

### Changed — MCP

- `pushnotifi_request_ack` is no longer a gated stub. It calls `POST /message` with `priority: 2`, reads the server-minted `alert_id`, and returns it as `correlation_id`.
- `pushnotifi_await_ack` polls the new `GET /alerts/:alert_id/status` every 5s. Returns `{ acked: true, acked_at, acked_by_device_id }` on ack or `{ acked: false, reason: 'timeout' }`.
- `PUSHNOTIFI_ACK_ENDPOINT` env var removed (no longer needed; endpoints are part of the regular API).
- `PHASE3_NOT_CONFIGURED` error code removed.
- `mcp.json` no longer lists the `PUSHNOTIFI_ACK_ENDPOINT` env mapping.

### Documentation

- `docs/phase-3-backend-spec.md` rewritten. Phase 3a is documented as the live contract. Phase 3b (options + free-text replies) is documented as the next-step requirements for backend + mobile.

### Known gaps (Phase 3b, deferred)

- `request_ack` does not yet accept `options: string[]`; mobile shows a single Acknowledge button. Yes/no/free-text replies are pending mobile-app work.
- The agent's prompt must phrase requests so that the safe default is *not* tapping (timeout = "do not proceed"). Documented in the tool description.
- Agents should set `timeout_seconds` ≤ 300s for production-write actions to bound implicit-authorization risk.

## [0.2.0] — Phase 2 + Phase 3 (gated)

### Added

- **Phase 2 MCP server** at `mcp/` (`pushnotifime-mcp`).
  - Tools: `pushnotifi_send`, `pushnotifi_list_messages`, `pushnotifi_list_groups`, `pushnotifi_test`.
  - Stdio transport via `@modelcontextprotocol/sdk`.
  - Token-bucket rate limiter (default 30/min, override with `PUSHNOTIFI_RATE_LIMIT_PER_MINUTE`).
  - Auto-derived idempotency keys (SHA-256 over canonical args) when the caller omits `idempotency_key`.
  - Typed errors: `MISSING_ENV`, `INVALID_ARG`, `RATE_LIMITED`, `API_ERROR`, `NETWORK_ERROR`, `TIMEOUT`.
  - Plugin-root `mcp.json` wires the server into Cursor.
- **Phase 3 ack tools** (`pushnotifi_request_ack`, `pushnotifi_await_ack`) implemented as gated stubs (superseded by 3a in 0.3.0).
- **`docs/phase-3-backend-spec.md`** — initial draft of the backend contract.

## [0.1.0] — Phase 1 skeleton

Initial scaffold derived from `cursor/plugin-template`, flattened to single-plugin layout.

### Added

- `skills/pushnotifi-scaffold` — canonical SDK / REST contract for Node, Python, Go, shell, Next.js, Express.
- `skills/pushnotifi-recipes` — failed-cron, webhook-signature, DB-migration, error-rate-threshold, shell/CI inbound-webhook recipes.
- `rules/pushnotifi-secrets` — auto-attached secret-handling rule.
- `rules/webhook-resilience` — auto-attached rule for inbound webhook handlers.
- `commands/init` — `/pushnotifi init` bootstraps SDK install, `.env.example`, `.gitignore`.
- `commands/test` — `/pushnotifi test` sends a single confirmation push.
