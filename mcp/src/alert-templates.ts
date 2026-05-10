/**
 * Phase 3b a1 — pre-registered response templates.
 *
 * MUST stay byte-for-byte aligned with `api/src/utils/alertResponseTemplate.ts`,
 * `jobs/src/alertResponseTemplate.ts`, and `mobile-app/lib/utils/alert_response_template.dart`.
 *
 * `freetext` carries no labels; the user types a reply on the message detail screen.
 *
 * Ack payload returned by `pushnotifi_await_ack`:
 *   - `response`: `null` — legacy binary ack (no template, or template `ack`).
 *   - `response`: exact label — e.g. `"Approve"`, `"Yes"` (fixed templates).
 *   - `response`: free string — user-typed reply when template is `freetext`.
 *   - `comment`: optional note with fixed-label templates; stored separately from `response`.
 *
 * Server validates each shape against the originating message snapshot
 * (`api/src/utils/alertResponseTemplate.ts → validateAckAgainstSnapshot`).
 */
export const ALERT_RESPONSE_TEMPLATES = {
  ack: ["Acknowledge"],
  yes_no: ["Yes", "No"],
  approve_deny: ["Approve", "Deny"],
  proceed_abort: ["Proceed", "Abort"],
  confirm_cancel: ["Confirm", "Cancel"],
  freetext: [],
} as const satisfies Record<string, readonly string[]>;

export type AlertResponseTemplate = keyof typeof ALERT_RESPONSE_TEMPLATES;

export const ALERT_RESPONSE_TEMPLATE_IDS: readonly AlertResponseTemplate[] = Object.freeze(
  Object.keys(ALERT_RESPONSE_TEMPLATES) as AlertResponseTemplate[]
);

export function isAlertResponseTemplate(value: unknown): value is AlertResponseTemplate {
  return (
    typeof value === "string" &&
    (ALERT_RESPONSE_TEMPLATE_IDS as readonly string[]).includes(value)
  );
}
