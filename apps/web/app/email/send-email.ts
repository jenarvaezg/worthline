/**
 * The one place `apps/web` sends an email (#1174, PRD #1171).
 *
 * Built for reuse: the feedback channel (#1174) is its first caller and the trial
 * emails (#1173) are the next. A caller hands over a message and gets back what
 * happened — it never throws, because every caller so far has something more
 * important than the email to protect (the feedback is already in `/admin`; a
 * trial transition must not roll back over a mail outage), so how to degrade is
 * the caller's call, not this module's.
 *
 * Email is OPTIONAL infrastructure. Without `RESEND_API_KEY` the send is a
 * `skipped` result, not an error: local dev, previews and e2e run without it, and
 * a feature that rides on email must keep working with the mail switched off.
 *
 * Resend over plain `fetch`, not the `resend` SDK. The API surface used is one
 * endpoint (`POST /emails`), and the SDK's own `fetchRequest` is a thin wrapper
 * over the same call — it neither retries nor reshapes the error, it returns the
 * parsed body as is. What it would add is a dependency carrying two transitive
 * packages for receiving mail and verifying webhooks, neither of which worthline
 * uses. Plain `fetch` keeps the request testable by injection (the same seam the
 * price fetchers use) and runs unchanged on Bun and on Vercel's Node.
 *
 * Contract checked against https://resend.com/docs/api-reference/emails/send-email
 * (2026-10-11): bearer auth, snake_case body (`reply_to`, not the SDK's
 * `replyTo`), success body `{ id }`, optional `Idempotency-Key` header (unique per
 * request, kept 24 h, ≤256 chars).
 */

const RESEND_SEND_URL = "https://api.resend.com/emails";

/**
 * Resend's shared testing sender. It delivers ONLY to the address that owns the
 * Resend account, which is exactly enough for a maintainer notification before a
 * domain is verified — and not enough for mail to users: #1173 needs
 * `WORTHLINE_EMAIL_FROM` on a verified domain (Resend answers 403 otherwise).
 */
export const RESEND_SANDBOX_FROM = "worthline <onboarding@resend.dev>";

/** A Resend call that hangs must not hold the caller (a server action) open. */
const SEND_TIMEOUT_MS = 10_000;

export type EmailEnv = Readonly<Record<string, string | undefined>>;

export interface EmailConfig {
  apiKey: string;
  /** `Name <address>` on a domain verified in Resend, or the sandbox sender. */
  from: string;
}

export interface EmailMessage {
  to: string | readonly string[];
  subject: string;
  /**
   * Plain-text body. Text only on purpose so far: a body that carries what a user
   * typed needs no HTML escaping if it is never HTML.
   */
  text: string;
  /** Where a reply goes — e.g. the user who wrote the feedback. */
  replyTo?: string;
  /** Resend dedups sends that share this key for 24 h: a retried call mails once. */
  idempotencyKey?: string;
  /** Resend tags: ASCII letters, digits, `_` and `-` only. */
  tags?: ReadonlyArray<{ name: string; value: string }>;
}

export type SendEmailResult =
  | { status: "sent"; id: string }
  | { status: "skipped"; reason: "not_configured" }
  | { status: "failed"; error: string; httpStatus: number | null };

/**
 * The email coordinates `env` declares, or null when there is no Resend key —
 * the ordinary state of local dev, not a misconfiguration.
 */
export function emailConfigFromEnv(env: EmailEnv = process.env): EmailConfig | null {
  const apiKey = env["RESEND_API_KEY"]?.trim();
  if (!apiKey) return null;
  const from = env["WORTHLINE_EMAIL_FROM"]?.trim() || RESEND_SANDBOX_FROM;
  return { apiKey, from };
}

export interface SendEmailOptions {
  /** Already-resolved coordinates; skips the env read. */
  config?: EmailConfig | null;
  /** Where to read the coordinates from when `config` is absent. */
  env?: EmailEnv;
  fetch?: typeof fetch;
}

function requestBody(message: EmailMessage, from: string): Record<string, unknown> {
  return {
    from,
    to: typeof message.to === "string" ? [message.to] : [...message.to],
    subject: message.subject,
    text: message.text,
    ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    ...(message.tags && message.tags.length > 0 ? { tags: [...message.tags] } : {}),
  };
}

/** Resend's error body, read defensively: the shape is undocumented, so any part may be missing. */
async function describeFailure(response: Response): Promise<string> {
  const raw = await response.text().catch(() => "");
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; name?: unknown };
    const message = typeof parsed.message === "string" ? parsed.message : null;
    const name = typeof parsed.name === "string" ? parsed.name : null;
    if (message) return name ? `${name}: ${message}` : message;
  } catch {
    // Not JSON (a proxy's HTML page): fall through to the status line.
  }
  return `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
}

/** Send one email through Resend. Never throws — see the module contract. */
export async function sendEmail(
  message: EmailMessage,
  options: SendEmailOptions = {},
): Promise<SendEmailResult> {
  const config =
    options.config === undefined ? emailConfigFromEnv(options.env) : options.config;
  if (!config) return { reason: "not_configured", status: "skipped" };

  const fetchImpl = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(RESEND_SEND_URL, {
      body: JSON.stringify(requestBody(message, config.from)),
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...(message.idempotencyKey ? { "Idempotency-Key": message.idempotencyKey } : {}),
      },
      method: "POST",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      httpStatus: null,
      status: "failed",
    };
  }

  if (!response.ok) {
    return {
      error: await describeFailure(response),
      httpStatus: response.status,
      status: "failed",
    };
  }

  const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof body?.id !== "string" || body.id.length === 0) {
    return {
      error: "Resend answered without an email id.",
      httpStatus: response.status,
      status: "failed",
    };
  }
  return { id: body.id, status: "sent" };
}
