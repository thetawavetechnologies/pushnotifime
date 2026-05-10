---
name: pushnotifi-scaffold
description: Generate PushNotifi.me notification calls in Node, Python, Go, shell/curl, Next.js, or Express. Use when the user asks to "send a push", "notify", "alert", or "wire up PushNotifi". Encodes the canonical SDK contract, default-application semantics, idempotency, and typed error handling.
---

# PushNotifi scaffold

## When to use

- The user asks to add a notification, alert, or push to existing code.
- The user wants the PushNotifi SDK or REST API integrated into a new project.
- An agent needs to inject an alert into a try/catch, cron job, or webhook handler.

Do **not** use this skill for:

- End-user product notifications inside a consumer app UI (use a transactional-email or in-app channel instead — PushNotifi is operational).
- Bulk fan-out marketing pushes.

## Canonical contract

Auth: header `X-API-Key: <PUSHNOTIFI_USER_KEY>`.
Base URL: `https://api.pushnotifi.me` (override with `PUSHNOTIFI_API_BASE_URL`).
Send endpoint: `POST /api/v1/message`.

Request body fields (mirrors the dashboard / OpenAPI schema):

| Field             | Required | Notes |
| ----------------- | -------- | ----- |
| `type`            | yes      | `"user"` or `"group"` |
| `send_to_key`     | yes      | `u…` (user) or `g…` (group), 32 chars |
| `message`         | yes      | Plain text body |
| `title`           | no       | Short identifier |
| `priority`        | no       | `-2 | -1 | 0 | 1 | 2`; default `0` |
| `application_key` | no       | Omit to use account default application |
| `idempotency_key` | recommended | Stable string per logical event; required for retries to be safe |
| `url`, `url_title`| no       | Deep-link tap target |
| `ttl`             | no       | Seconds before drop |
| `attachment_base64`, `attachment_type` | no | Image attachment |

Successful response: `{ "message": "<human-readable status>" }`.
Failures: throw `PushNotifiMeError` (Node SDK) with `status` (HTTP code) and `body` (parsed JSON when available).

Default-application semantics: if neither the constructor `applicationKey` nor the per-message `application_key` is set, the API uses the account's default application. Do not invent values.

## Node (preferred — `pushnotifime` SDK)

Install: `npm install pushnotifime` (Node 18+ for global `fetch`).

```ts
import { PushNotifiMe, PushNotifiMeError } from "pushnotifime";

const userKey = process.env.PUSHNOTIFI_USER_KEY;
if (!userKey) throw new Error("PUSHNOTIFI_USER_KEY is not set");

const pn = new PushNotifiMe({ userKey });

export async function alert(title: string, message: string, idempotencyKey: string) {
  try {
    return await pn.send({
      type: "group",
      send_to_key: process.env.PUSHNOTIFI_GROUP_KEY!,
      title,
      message,
      priority: 1,
      idempotency_key: idempotencyKey,
    });
  } catch (err) {
    if (err instanceof PushNotifiMeError) {
      console.error("pushnotifi failed", err.status, err.body);
    }
    throw err;
  }
}
```

Other SDK methods you can scaffold without re-implementing:

- `pn.listApplications()` → `GET /api/v1/applications`
- `pn.getApplication(applicationKey)` → `GET /api/v1/applications/:application_key`
- `pn.listGroups()` → `GET /api/v1/groups`
- `pn.listMessages()` → `GET /api/v1/messages` (history)

## Python (REST, no SDK)

```python
import os, json, urllib.request, urllib.error

API = os.environ.get("PUSHNOTIFI_API_BASE_URL", "https://api.pushnotifi.me")
KEY = os.environ["PUSHNOTIFI_USER_KEY"]
GROUP = os.environ["PUSHNOTIFI_GROUP_KEY"]

def alert(title: str, message: str, idempotency_key: str) -> dict:
    body = json.dumps({
        "type": "group",
        "send_to_key": GROUP,
        "title": title,
        "message": message,
        "priority": 1,
        "idempotency_key": idempotency_key,
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{API}/api/v1/message",
        data=body,
        headers={"Content-Type": "application/json", "X-API-Key": KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"pushnotifi {e.code}: {e.read().decode('utf-8', 'ignore')}") from e
```

## Go (REST, stdlib)

```go
package pn

import (
    "bytes"
    "context"
    "encoding/json"
    "fmt"
    "net/http"
    "os"
    "time"
)

type sendBody struct {
    Type           string `json:"type"`
    SendToKey      string `json:"send_to_key"`
    Title          string `json:"title,omitempty"`
    Message        string `json:"message"`
    Priority       int    `json:"priority,omitempty"`
    IdempotencyKey string `json:"idempotency_key,omitempty"`
}

func Alert(ctx context.Context, title, message, idemKey string) error {
    base := os.Getenv("PUSHNOTIFI_API_BASE_URL")
    if base == "" {
        base = "https://api.pushnotifi.me"
    }
    key := os.Getenv("PUSHNOTIFI_USER_KEY")
    group := os.Getenv("PUSHNOTIFI_GROUP_KEY")
    if key == "" || group == "" {
        return fmt.Errorf("PUSHNOTIFI_USER_KEY and PUSHNOTIFI_GROUP_KEY must be set")
    }
    body, err := json.Marshal(sendBody{
        Type: "group", SendToKey: group, Title: title, Message: message,
        Priority: 1, IdempotencyKey: idemKey,
    })
    if err != nil {
        return err
    }
    req, err := http.NewRequestWithContext(ctx, "POST", base+"/api/v1/message", bytes.NewReader(body))
    if err != nil {
        return err
    }
    req.Header.Set("Content-Type", "application/json")
    req.Header.Set("X-API-Key", key)
    client := &http.Client{Timeout: 10 * time.Second}
    resp, err := client.Do(req)
    if err != nil {
        return err
    }
    defer resp.Body.Close()
    if resp.StatusCode >= 300 {
        return fmt.Errorf("pushnotifi %d", resp.StatusCode)
    }
    return nil
}
```

## Shell / CI (curl)

Two send paths exist. Prefer the API-key path inside trusted environments; use the inbound-webhook-token path for ad-hoc shell scripts where you do not want to plumb the API key.

API key:

```bash
curl -fsS -X POST "https://api.pushnotifi.me/api/v1/message" \
  -H "X-API-Key: $PUSHNOTIFI_USER_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"group\",\"send_to_key\":\"$PUSHNOTIFI_GROUP_KEY\",\"title\":\"$1\",\"message\":\"$2\",\"priority\":1}"
```

Inbound webhook token (per-user secret, fetched from the dashboard):

```bash
curl -fsS -X POST "https://api.pushnotifi.me/api/v1/webhooks/incoming/$PUSHNOTIFI_WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"title\":\"$1\",\"message\":\"$2\"}"
```

## Express middleware (error boundary)

```ts
import express from "express";
import { PushNotifiMe } from "pushnotifime";

const pn = new PushNotifiMe(process.env.PUSHNOTIFI_USER_KEY!);

export function pushnotifiErrorAlerts(): express.ErrorRequestHandler {
  return async (err, req, _res, next) => {
    try {
      await pn.send({
        type: "group",
        send_to_key: process.env.PUSHNOTIFI_GROUP_KEY!,
        title: `Unhandled error: ${req.method} ${req.path}`,
        message: (err as Error).message,
        priority: 1,
        idempotency_key: `req:${req.headers["x-request-id"] ?? Date.now()}`,
      });
    } catch (alertErr) {
      console.error("pushnotifi alert failed", alertErr);
    }
    next(err);
  };
}
```

Mount **after** all routes: `app.use(pushnotifiErrorAlerts());`.

## Invariants the generated code must satisfy

1. Every `send()` call has a stable `idempotency_key` if it is reachable from a retry path (cron, webhook, queue worker).
2. No code path swallows a `PushNotifiMeError` silently; either re-throw, log with status, or both.
3. Keys are read from env vars listed in the `pushnotifi-secrets` rule. Never literals.
4. Do not introduce a new dependency for HTTP — use the SDK in Node, the language stdlib elsewhere.
5. Do not wrap a function that already alerts; the agent must check before adding a wrapper (idempotent edits).
