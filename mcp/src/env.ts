/**
 * Environment validation. Reads once at process start. Fails fast.
 * Secrets never leave this module; consumers receive a frozen config object.
 */

export interface Env {
  readonly userKey: string;
  readonly groupKey: string | null;
  readonly applicationKey: string | null;
  readonly apiBaseUrl: string;
  readonly rateLimitPerMinute: number;
  readonly defaultAckTimeoutSeconds: number;
  readonly maxAckTimeoutSeconds: number;
}

const DEFAULT_API_BASE_URL = "https://api.pushnotifi.me";
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const DEFAULT_ACK_TIMEOUT_SECONDS = 900; // 15 minutes
const MAX_ACK_TIMEOUT_SECONDS = 3600;    // 1 hour hard cap

function readString(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === null) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readPositiveInt(name: string, fallback: number): number {
  const raw = readString(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return n;
}

export function loadEnv(): Env {
  const userKey = readString("PUSHNOTIFI_USER_KEY");
  if (userKey === null) {
    throw new Error(
      "PUSHNOTIFI_USER_KEY is required but not set. " +
        "Get your API key from https://pushnotifi.me/dashboard."
    );
  }

  const apiBaseUrl = (readString("PUSHNOTIFI_API_BASE_URL") ?? DEFAULT_API_BASE_URL).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(apiBaseUrl)) {
    throw new Error(`PUSHNOTIFI_API_BASE_URL must start with http:// or https://, got "${apiBaseUrl}"`);
  }

  const rateLimitPerMinute = readPositiveInt(
    "PUSHNOTIFI_RATE_LIMIT_PER_MINUTE",
    DEFAULT_RATE_LIMIT_PER_MINUTE
  );

  return Object.freeze({
    userKey,
    groupKey: readString("PUSHNOTIFI_GROUP_KEY"),
    applicationKey: readString("PUSHNOTIFI_APPLICATION_KEY"),
    apiBaseUrl,
    rateLimitPerMinute,
    defaultAckTimeoutSeconds: DEFAULT_ACK_TIMEOUT_SECONDS,
    maxAckTimeoutSeconds: MAX_ACK_TIMEOUT_SECONDS,
  });
}

export function redactKey(key: string): string {
  if (key.length <= 4) return "****";
  return `****${key.slice(-4)}`;
}
