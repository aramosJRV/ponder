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
