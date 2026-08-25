/**
 * Turn a thrown value into something worth showing a user.
 *
 * supabase-js surfaces some GoTrue failures as an error whose message is the
 * JSON-stringified (and empty) response body — the app rendered a literal
 * "{}" at the user when an SMTP send failed. Anything that unhelpful gets
 * replaced with plain language.
 */
export function userMessage(e: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const msg = raw.trim();
  if (!msg || msg === "{}" || msg === "[]" || msg === "null" || msg === "undefined") return fallback;
  // GoTrue's generic 500 when the mail provider rejects the send.
  if (/unexpected_failure|Error sending|could not send email/i.test(msg)) {
    return "We couldn’t send that email just now. Please try again in a moment.";
  }
  return msg;
}

/**
 * One error message for four causes is how the last two outages hid.
 *
 * The 25 Aug outage looked like "couldn't reach the server" on a Pixel with
 * full signal; the actual cause was a 403 from a column-level grant. Today's
 * load() caught everything in a bare `catch {}` and printed one string, so
 * there was nothing on screen — or in a tester's screenshot — to tell a dead
 * network apart from a database that refused the query.
 *
 * classifyError() exists to make that distinction visible. It never changes
 * behaviour; it only says WHY, in a form a screenshot can carry.
 */

export type ErrorKind = "offline" | "auth" | "denied" | "server" | "unknown";

export interface ClassifiedError {
  kind: ErrorKind;
  /** Short token shown in the UI and searchable in logs, e.g. "42501". */
  code: string;
  /** Full detail for console.error — never rendered to the user. */
  detail: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pick(e: any, k: string): string {
  const v = e && typeof e === "object" ? e[k] : undefined;
  return typeof v === "string" ? v : "";
}

export function classifyError(e: unknown): ClassifiedError {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const err = e as any;
  const message = pick(err, "message") || String(e ?? "");
  const code = pick(err, "code");
  const status = typeof err?.status === "number" ? err.status : 0;
  const detail = JSON.stringify({
    name: pick(err, "name"),
    message,
    code,
    status,
    details: pick(err, "details"),
    hint: pick(err, "hint"),
  });

  // The device says it has no network, or fetch never reached a server.
  // supabase-js surfaces this as a TypeError: "Failed to fetch" on Android,
  // "Load failed" in WKWebView.
  const offline =
    (typeof navigator !== "undefined" && navigator.onLine === false) ||
    err?.name === "TypeError" ||
    /failed to fetch|load failed|network ?error|networkerror/i.test(message);
  if (offline) return { kind: "offline", code: "OFFLINE", detail };

  // Postgres 42501 / PostgREST permission failures. This is the shape the
  // column-grant outage took, and it must never read as a network problem.
  if (code === "42501" || /permission denied|not authorized/i.test(message)) {
    return { kind: "denied", code: code || "42501", detail };
  }

  if (status === 401 || status === 403 || /jwt|token|session/i.test(message)) {
    return { kind: "auth", code: code || (status ? String(status) : "AUTH"), detail };
  }

  if (code || status >= 400) {
    return { kind: "server", code: code || String(status), detail };
  }

  return { kind: "unknown", code: "ERR", detail };
}

/** Log with a stable prefix so `adb logcat | grep Ponder` finds it. */
export function logError(where: string, e: unknown): ClassifiedError {
  const c = classifyError(e);
  console.error(`[Ponder] ${where} failed (${c.kind}/${c.code}) ${c.detail}`);
  return c;
}

/** Headline + body for a full-screen failure. Code is rendered separately. */
export function errorCopy(kind: ErrorKind): { title: string; body: string } {
  switch (kind) {
    case "offline":
      return {
        title: "You're offline",
        body: "Ponder couldn't reach the internet, and there's no synced copy of today on this device.",
      };
    case "denied":
    case "server":
      return {
        title: "Something's wrong at our end",
        body: "The server turned this request away. That's a bug on our side, not anything you did — it's been logged.",
      };
    case "auth":
      return {
        title: "Couldn't verify your account",
        body: "Ponder reached the server but couldn't confirm who you are. Try again in a moment.",
      };
    default:
      return {
        title: "Nothing to show yet",
        body: "Something went wrong loading today, and there's no synced copy on this device.",
      };
  }
}
