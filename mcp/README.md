# pushnotifime-mcp

MCP (Model Context Protocol) server for PushNotifi.me. Exposes notification, history, and human-in-the-loop tools to Cursor agents and any other MCP-aware client.

## Tools

### Phase 2 (production)

| Tool                       | Maps to                            | Notes |
| -------------------------- | ---------------------------------- | ----- |
| `pushnotifi_send`          | `POST /api/v1/message`             | Auto-derives `idempotency_key` from args hash if omitted. Rate-limited. |
| `pushnotifi_list_messages` | `GET /api/v1/messages`             | Account-wide outbound history. |
| `pushnotifi_list_groups`   | `GET /api/v1/groups`               | Used so the agent can pick a target. |
| `pushnotifi_test`          | `POST /api/v1/message` (fixed)     | Smoke test for the MCP install. |

### Phase 3 (gated stubs)

| Tool                      | Status                              | Maps to (when backend ships)                |
| ------------------------- | ----------------------------------- | ------------------------------------------- |
| `pushnotifi_request_ack`  | Returns `PHASE3_NOT_CONFIGURED`     | `POST ${PUSHNOTIFI_ACK_ENDPOINT}/requests`  |
| `pushnotifi_await_ack`    | Returns `PHASE3_NOT_CONFIGURED`     | `GET  ${PUSHNOTIFI_ACK_ENDPOINT}/requests/:correlation_id` |

The stubs return a typed error until `PUSHNOTIFI_ACK_ENDPOINT` is set on the server. See [`../docs/phase-3-backend-spec.md`](../docs/phase-3-backend-spec.md) for the contract the backend must implement.

## Safety properties

These are not preferences — they are hard rules from the strategic analysis (`../ANALYSIS.md` §8):

1. **API key never appears in tool arguments.** It is read from `PUSHNOTIFI_USER_KEY` at startup. This removes a prompt-injection vector.
2. **Rate-limit enforced client-side.** Default 30 sends/minute (`PUSHNOTIFI_RATE_LIMIT_PER_MINUTE`). An agent in a retry loop cannot page the user thousands of times.
3. **Auto idempotency.** If the caller does not supply `idempotency_key`, the server derives one from a stable hash of the canonical args. Transport retries do not produce duplicates.
4. **Failures fail loudly.** Every error is a typed `{ code, message, details }` payload the agent can branch on. No silent swallow.

## Environment variables

| Variable                              | Required                       | Default                          |
| ------------------------------------- | ------------------------------ | -------------------------------- |
| `PUSHNOTIFI_USER_KEY`                 | yes                            | —                                |
| `PUSHNOTIFI_GROUP_KEY`                | yes for `_test` and default-target sends | —                          |
| `PUSHNOTIFI_APPLICATION_KEY`          | no                             | account default application      |
| `PUSHNOTIFI_API_BASE_URL`             | no                             | `https://api.pushnotifi.me`      |
| `PUSHNOTIFI_RATE_LIMIT_PER_MINUTE`    | no                             | `30`                             |
| `PUSHNOTIFI_ACK_ENDPOINT`             | required for Phase 3 tools     | unset (Phase 3 returns gated err)|

## Build and run

From this directory:

```bash
npm install
npm run build
PUSHNOTIFI_USER_KEY=... PUSHNOTIFI_GROUP_KEY=g... node dist/server.js
```

The server speaks MCP over stdio. To wire it into Cursor, see the plugin-root `mcp.json` (one level up).

## Publishing

```bash
npm run clean && npm run build
npm publish --access public
```

After publish, the plugin's `mcp.json` can be flipped from the local `node ./mcp/dist/server.js` form to `npx -y pushnotifime-mcp`.

## License

MIT.
