---
name: pushnotifi-recipes
description: Opinionated PushNotifi recipes for common operational alert patterns — failed cron jobs, webhook signature mismatches, DB migration failures, external-API error-rate thresholds, and shell/CI shortcuts via inbound webhook tokens. Use when the user describes one of these patterns or asks for a "monitor X" / "alert me when Y" template.
---

# PushNotifi recipes

Each recipe is small, single-purpose, and uses only `pushnotifime` (Node) or stdlib HTTP. Pick one. Do not blend recipes; the alert semantics are different.

All recipes assume the `pushnotifi-secrets` rule is in effect and read from `PUSHNOTIFI_USER_KEY`, `PUSHNOTIFI_GROUP_KEY`, and (where noted) `PUSHNOTIFI_WEBHOOK_TOKEN`.

## Recipe 1 — Failed cron job

Use when: a scheduled task may fail silently and you currently have no visibility.

```ts
import { PushNotifiMe } from "pushnotifime";

const pn = new PushNotifiMe(process.env.PUSHNOTIFI_USER_KEY!);

export async function runCron(jobName: string, runId: string, work: () => Promise<void>) {
  const start = Date.now();
  try {
    await work();
  } catch (err) {
    const ms = Date.now() - start;
    await pn.send({
      type: "group",
      send_to_key: process.env.PUSHNOTIFI_GROUP_KEY!,
      title: `Cron failed: ${jobName}`,
      message: `${(err as Error).message} (after ${ms}ms)`,
      priority: 1,
      idempotency_key: `cron:${jobName}:${runId}`,
    });
    throw err;
  }
}
```

Invariants:

- `runId` must be a stable per-run identifier (e.g. ISO timestamp truncated to the schedule grain — `2026-05-10T03:00:00Z` for an hourly job). Never `Date.now()`.
- The function re-throws so the scheduler sees the failure too.

## Recipe 2 — Webhook signature mismatch

See the `webhook-resilience` rule. Signature failures are a security event, not noise. Always `priority: 1`. Idempotency key derived from the offending signature header so repeated attacks deduplicate.

## Recipe 3 — DB migration failure

Use when: a migration step is irreversible-ish and you need to know immediately if it broke.

```ts
import { PushNotifiMe } from "pushnotifime";

const pn = new PushNotifiMe(process.env.PUSHNOTIFI_USER_KEY!);

export async function runMigration(name: string, version: string, apply: () => Promise<void>) {
  try {
    await apply();
    await pn.send({
      type: "group",
      send_to_key: process.env.PUSHNOTIFI_GROUP_KEY!,
      title: `Migration applied: ${name}`,
      message: `version ${version} ok`,
      priority: -1,
      idempotency_key: `mig:ok:${name}:${version}`,
    });
  } catch (err) {
    await pn.send({
      type: "group",
      send_to_key: process.env.PUSHNOTIFI_GROUP_KEY!,
      title: `Migration FAILED: ${name}`,
      message: `version ${version}: ${(err as Error).message}`,
      priority: 2,
      idempotency_key: `mig:fail:${name}:${version}`,
    });
    throw err;
  }
}
```

Note: success uses `priority: -1` (low) so it lands quietly; failure uses `priority: 2` (max) so it interrupts.

## Recipe 4 — External API error-rate threshold

Use when: a downstream API (Stripe, OpenAI, Shopify) flakes occasionally and per-request alerts would page you 1000 times/hour.

The pattern is a **counter + window**, not per-request. One push per window per error class.

```ts
import { PushNotifiMe } from "pushnotifime";

const pn = new PushNotifiMe(process.env.PUSHNOTIFI_USER_KEY!);

const WINDOW_MS = 5 * 60_000;
const THRESHOLD = 10;

const counters = new Map<string, { count: number; windowStart: number; alerted: boolean }>();

export async function trackApiError(api: string, errCode: string) {
  const key = `${api}:${errCode}`;
  const now = Date.now();
  const c = counters.get(key);
  if (!c || now - c.windowStart > WINDOW_MS) {
    counters.set(key, { count: 1, windowStart: now, alerted: false });
    return;
  }
  c.count += 1;
  if (c.count >= THRESHOLD && !c.alerted) {
    c.alerted = true;
    await pn.send({
      type: "group",
      send_to_key: process.env.PUSHNOTIFI_GROUP_KEY!,
      title: `${api} error-rate threshold`,
      message: `${c.count} ${errCode} errors in ${Math.round((now - c.windowStart) / 1000)}s`,
      priority: 1,
      idempotency_key: `rate:${key}:${c.windowStart}`,
    });
  }
}
```

Invariants:

- `idempotency_key` includes `windowStart` so each window can alert once even if the process restarts and re-evaluates.
- Counters live in-process. For multi-instance deploys, replace the `Map` with Redis or skip this recipe.

## Recipe 5 — Shell / CI inbound-webhook token

Use when: you want a one-line `curl` from a shell script, GitHub Action, or Docker entrypoint without plumbing the API key.

Each user generates their own inbound-webhook token from the dashboard. Treat the token as a secret — it is per-user, not shared.

```bash
# .github/workflows/deploy.yml — notify on failure
- name: Notify on failure
  if: failure()
  env:
    PUSHNOTIFI_WEBHOOK_TOKEN: ${{ secrets.PUSHNOTIFI_WEBHOOK_TOKEN }}
  run: |
    curl -fsS -X POST \
      "https://api.pushnotifi.me/api/v1/webhooks/incoming/$PUSHNOTIFI_WEBHOOK_TOKEN" \
      -H "Content-Type: application/json" \
      -d "{\"title\":\"Deploy failed\",\"message\":\"${GITHUB_REPOSITORY} run ${GITHUB_RUN_ID}\"}"
```

```bash
# scripts/notify.sh — generic CLI helper
set -euo pipefail
: "${PUSHNOTIFI_WEBHOOK_TOKEN:?must be set}"
title="${1:?title required}"
message="${2:?message required}"
curl -fsS -X POST \
  "https://api.pushnotifi.me/api/v1/webhooks/incoming/${PUSHNOTIFI_WEBHOOK_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$(jq -nc --arg t "$title" --arg m "$message" '{title:$t, message:$m}')"
```

Invariants:

- The token is never echoed, logged, or interpolated into a URL stored in a log file. `set -x` should not be on.
- `set -euo pipefail` is required — silent shell failure defeats the recipe's purpose.

## When *not* to send a notification

Refuse to scaffold an alert when:

- The error is recoverable in the same call (the agent should retry, not page).
- The handler is a high-frequency hot path (>1/s) without a counter+window wrapper. Recipe 4 is mandatory in that case.
- The user is asking for end-user product notifications. PushNotifi is operational; recommend a different channel.
