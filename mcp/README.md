# pushnotifime-mcp

MCP (Model Context Protocol) server for [PushNotifi.me](https://pushnotifi.me).
Exposes notification, history, and **human-in-the-loop approval** tools to
Cursor agents and any other MCP-aware client.

## Tools

| Tool                       | Maps to                                              | Notes |
| -------------------------- | ---------------------------------------------------- | ----- |
| `pushnotifi_send`          | `POST /api/v1/message`                               | Sends a notification. Auto-derives `idempotency_key` from the canonical args hash if omitted. Rate-limited. |
| `pushnotifi_list_messages` | `GET /api/v1/messages`                               | Account-wide outbound history. |
| `pushnotifi_list_groups`   | `GET /api/v1/groups`                                 | List groups available to the account. |
| `pushnotifi_test`          | `POST /api/v1/message` (fixed)                       | Smoke test for the MCP install. Requires `PUSHNOTIFI_GROUP_KEY`. |
| `pushnotifi_request_ack`   | `POST /api/v1/message` with `priority: 2`            | Asks the user for a decision on their phone. Returns `correlation_id`. The send `type` is inferred from `send_to_key` (`u…` → user, `g…` → group). Optional `response_template` (`ack \| yes_no \| approve_deny \| proceed_abort \| confirm_cancel \| freetext`) renders the matching button set. |
| `pushnotifi_await_ack`     | `GET /api/v1/alerts/:alert_id/status` (poll)         | Blocks until the user acks or `timeout_seconds` (default 900 s, max 3600 s) expires. Returns `{ acked, acked_at, acked_by_device_id, response, comment }` on ack, or `{ acked: false, reason: 'timeout' }`. |

### `await_ack` resilience

The polling loop treats these as transient and keeps polling within the
deadline (instead of failing the whole call):

- network errors and request timeouts
- HTTP `429` (honors `Retry-After`, capped at 60 s)
- HTTP `502`, `503`, `504`

Other 4xx errors fail fast.

## Safety properties

These are hard rules baked into the server, not preferences:

1. **API key never appears in tool arguments.** It is read from
   `PUSHNOTIFI_USER_KEY` at startup. Removes a prompt-injection vector — an
   agent compromised by a malicious tool result still cannot exfiltrate or
   override the key.
2. **Rate-limit enforced client-side.** Default 30 sends/min
   (`PUSHNOTIFI_RATE_LIMIT_PER_MINUTE`). An agent stuck in a retry loop
   cannot page the user thousands of times.
3. **Auto idempotency.** If the caller does not supply `idempotency_key`,
   the server derives one from a SHA-256 hash of the canonical args.
   Transport retries do not produce duplicate sends.
4. **Failures fail loudly.** Every error is a typed
   `{ code, message, details }` payload the agent can branch on. No silent
   swallow. Codes: `MISSING_ENV`, `INVALID_ARG`, `RATE_LIMITED`,
   `API_ERROR`, `NETWORK_ERROR`, `TIMEOUT`.

## Environment variables

| Variable                           | Required | Default                     | Notes |
| ---------------------------------- | -------- | --------------------------- | ----- |
| `PUSHNOTIFI_USER_KEY`              | **yes**  | —                           | Account API key, sent as `X-API-Key`. Get from [pushnotifi.me/dashboard](https://pushnotifi.me/dashboard). The server fails to start without it. |
| `PUSHNOTIFI_GROUP_KEY`             | for `_test` and default-target sends | —     | 32-char `g…` group key. Used as the default `send_to_key` when the tool call omits one (and required by `pushnotifi_test`). |
| `PUSHNOTIFI_APPLICATION_KEY`       | no       | account default application | Forwarded as `application_key` on `pushnotifi_send`. |
| `PUSHNOTIFI_API_BASE_URL`          | no       | `https://api.pushnotifi.me` | Override for self-hosted or staging environments. Must start with `http://` or `https://`. |
| `PUSHNOTIFI_RATE_LIMIT_PER_MINUTE` | no       | `30`                        | Outbound-send token bucket. Positive integer. |

The MCP server validates these at startup and exits with a clear error if
`PUSHNOTIFI_USER_KEY` is missing or `PUSHNOTIFI_API_BASE_URL` is malformed.

## Build and run

From this directory:

```bash
npm install
npm run build
PUSHNOTIFI_USER_KEY=... PUSHNOTIFI_GROUP_KEY=g... node dist/server.js
```

The server speaks MCP over stdio. To wire it into Cursor, see the
plugin-root `mcp.json` (one level up).

## Publishing

```bash
npm run clean && npm run build
npm publish --access public
```

After publish, the plugin's `mcp.json` can be flipped from the local
`node ./mcp/dist/server.js` form to `npx -y pushnotifime-mcp`.

## License

MIT.
