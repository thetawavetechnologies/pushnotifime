/**
 * Derive a stable idempotency key from tool-call inputs when the caller did not supply one.
 *
 * Why: if the MCP transport retries a tool call (network blip), we do not want a duplicate push.
 * The PushNotifi server already deduplicates by `idempotency_key`, but only if the same key is sent.
 *
 * Strategy: hash the canonical form of the args. Same args → same key → server-side dedup.
 */

import { createHash } from "node:crypto";

export function deriveIdempotencyKey(prefix: string, args: unknown): string {
  const canonical = canonicalize(args);
  const hash = createHash("sha256").update(canonical).digest("hex").slice(0, 16);
  return `${prefix}:${hash}`;
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
    return `{${pairs.join(",")}}`;
  }
  return JSON.stringify(String(value));
}
