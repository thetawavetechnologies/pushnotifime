---
name: test
description: Send a test PushNotifi notification using the keys in the local environment. The first-run smoke test — must work end-to-end before any other plugin behavior is trusted.
---

# /pushnotifi test

Send a single test notification through the PushNotifi API to confirm credentials, network, and device delivery are all working.

## Steps (execute in order)

1. **Read environment.** Load `PUSHNOTIFI_USER_KEY` and `PUSHNOTIFI_GROUP_KEY` from `.env` (via `dotenv`-style loader if the project uses one) or from the shell environment. If either is missing or empty, stop and tell the user:

   > Missing PUSHNOTIFI_USER_KEY or PUSHNOTIFI_GROUP_KEY. Run `/pushnotifi init` first, then fill them in `.env`.

2. **Send the notification.** Use the `pushnotifime` SDK if it is already installed in the project; otherwise fall back to a single `curl` invocation. Body:

   ```json
   {
     "type": "group",
     "send_to_key": "<PUSHNOTIFI_GROUP_KEY>",
     "title": "Test from Cursor",
     "message": "PushNotifi plugin is working.",
     "priority": 0,
     "idempotency_key": "cursor-plugin-test:<unix-timestamp>"
   }
   ```

   `idempotency_key` uses the current Unix timestamp truncated to the second so re-runs of `/pushnotifi test` within the same second are deduplicated; re-runs across seconds always deliver a new push (which is what the user wants — they pressed the button twice).

3. **Report the result.**
   - On HTTP 2xx: print "Test notification sent. Check your PushNotifi mobile app." plus the API's response `message` field.
   - On HTTP 4xx: print the status code, the API's error message, and the most likely cause:
     - `401` → "API key is invalid or revoked."
     - `404` → "Group key was not found in your account."
     - `400` → "Bad request body — check that `send_to_key` is a 32-char `g…` key."
   - On network failure: print the underlying error and "Could not reach https://api.pushnotifi.me. Check connectivity."

## What this command does NOT do

- Does not send to a user `send_to_key` (`u…`). If the user wants that, they invoke the API directly. Group is the right default for "is this working".
- Does not retry on failure. The user pressed a button; show them the result.
- Does not redact or modify the API's response message — the user needs to see exactly what the server returned.
- Does not echo `PUSHNOTIFI_USER_KEY` to the terminal at any point, even on error.

## Reference invocation (curl fallback)

```bash
curl -fsS -X POST "${PUSHNOTIFI_API_BASE_URL:-https://api.pushnotifi.me}/api/v1/message" \
  -H "X-API-Key: $PUSHNOTIFI_USER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"group\",\"send_to_key\":\"$PUSHNOTIFI_GROUP_KEY\",\"title\":\"Test from Cursor\",\"message\":\"PushNotifi plugin is working.\",\"priority\":0,\"idempotency_key\":\"cursor-plugin-test:$(date +%s)\"}"
```
