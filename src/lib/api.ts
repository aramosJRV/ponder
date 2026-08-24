import { supabase, FUNCTIONS_URL } from "./supabase";
import { deviceTimezone } from "./dates";
import {
  refreshEntitlement,
  maxActiveThreads,
  GenerationDelayedError,
  SynthesisQuotaError,
} from "./entitlements";
import type {
  ContentReport,
  DailyEntry,
  Note,
  Profile,
  ReportReason,
  ReportTarget,
  ResolvedVerseRef,
  Synthesis,
  SynthesisKind,
  Topic,
} from "./types";

const PROFILE_COLS =
  "id, timezone, notification_hour, challenge_frequency, content_level";

/** The signed-in user's profile (timezone, notification hour, challenge freq).
 * Row is created by a signup trigger; returns null if not signed in / missing. */
export async function fetchProfile(): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select(PROFILE_COLS)
    .maybeSingle();
  if (error) throw error;
  return (data as Profile) ?? null;
}

export async function updateProfile(
  patch: Partial<
    Pick<Profile, "timezone" | "notification_hour" | "challenge_frequency" | "content_level">
  >,
): Promise<Profile> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("Not signed in");
  const { data, error } = await supabase
    .from("profiles")
    .update(patch)
    .eq("id", userId)
    .select(PROFILE_COLS)
    .single();
  if (error) throw error;
  return data as Profile;
}

/**
 * With no onboarding screen, a new profile starts at the 'UTC' default — wrong
 * for notifications and nightly generation. On first launch, if the profile is
 * still at that untouched default, adopt the device timezone. Once the user has
 * set a timezone in Settings we never override it. Best-effort: failure here
 * must never block app start.
 */
export async function ensureDeviceTimezone(): Promise<void> {
  try {
    const tz = deviceTimezone();
    if (!tz || tz === "UTC") return;
    const profile = await fetchProfile();
    if (!profile || profile.timezone !== "UTC") return;
    await updateProfile({ timezone: tz });
  } catch {
    /* non-fatal */
  }
}

/**
 * Record that the app was opened.
 *
 * Drives idle auto-pause: threads belonging to a user who hasn't opened
 * Ponder for 14 days are paused by a nightly job. That exists because cost is
 * driven by threads being *active*, not by anyone reading them — a lapsed
 * subscriber with three live threads costs real money generating entries
 * nobody sees, and comes back to a wall of unread days.
 *
 * Best-effort and fire-and-forget: never block app start on it, and never
 * surface a failure. Worst case we pause a thread for someone who was here —
 * which is one tap to undo and destroys nothing.
 */
export async function recordAppOpen(): Promise<void> {
  try {
    await supabase.rpc("touch_last_opened");
  } catch {
    /* non-fatal */
  }
}

export async function fetchActiveTopics(): Promise<Topic[]> {
  const { data, error } = await supabase
    .from("topics")
    .select("*")
    .eq("status", "active")
    .order("focus", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Topic[];
}

export async function fetchEntriesForDate(date: string): Promise<DailyEntry[]> {
  const { data, error } = await supabase
    .from("daily_entries")
    .select("*")
    .eq("date", date);
  if (error) throw error;
  return data as DailyEntry[];
}

export async function fetchNotesForEntries(entryIds: string[]): Promise<Note[]> {
  if (entryIds.length === 0) return [];
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .in("entry_id", entryIds)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Note[];
}

export async function addNote(entry: DailyEntry, body: string): Promise<Note> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("Not signed in");
  const { data, error } = await supabase
    .from("notes")
    .insert({
      entry_id: entry.id,
      topic_id: entry.topic_id,
      user_id: userId,
      body,
    })
    .select()
    .single();
  if (error) throw error;
  return data as Note;
}

// ---------------------------------------------------------------- topics

export async function fetchAllTopics(): Promise<Topic[]> {
  const { data, error } = await supabase
    .from("topics")
    .select("*")
    .order("status", { ascending: true }) // active < concluded < paused alphabetically? no — see sort below
    .order("created_at", { ascending: true });
  if (error) throw error;
  // stable app-level ordering: active (focus first), paused, concluded
  const rank = { active: 0, paused: 1, concluded: 2 } as const;
  return (data as Topic[]).sort(
    (a, b) =>
      rank[a.status] - rank[b.status] ||
      Number(b.focus) - Number(a.focus) ||
      a.created_at.localeCompare(b.created_at),
  );
}

/**
 * Resolve a typed reference ("1 Corinthians 13:4-7") against the WEB text.
 * Returns null when it cannot be parsed or the passage does not exist.
 * Same SQL the seed-verse trigger uses, so the preview can't disagree
 * with what actually gets stored.
 */
export async function parseVerseRef(ref: string): Promise<ResolvedVerseRef | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const { data, error } = await supabase.rpc("parse_verse_ref", { p_ref: trimmed });
  if (error) throw error;
  const rows = (data ?? []) as ResolvedVerseRef[];
  return rows[0] ?? null;
}

export async function createTopic(input: {
  title: string;
  description: string;
  focus: boolean;
  /** Optional seed passage. Coordinates only — ref/text are derived server-side. */
  seed?: Pick<
    ResolvedVerseRef,
    "book_number" | "chapter" | "verse_start" | "verse_end"
  > | null;
}): Promise<Topic> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("Not signed in");
  if (input.focus) await clearFocus();
  const { seed, ...fields } = input;
  const { data, error } = await supabase
    .from("topics")
    .insert({
      user_id: userId,
      ...fields,
      seed_book_number: seed?.book_number ?? null,
      seed_chapter: seed?.chapter ?? null,
      seed_verse_start: seed?.verse_start ?? null,
      seed_verse_end: seed?.verse_end ?? null,
    })
    .select()
    .single();
  if (error) throw asThreadLimitError(error);
  return data as Topic;
}

/** Threads that may be active at once for the CURRENT user. Mirrors the
 * Postgres max_active_topics(uuid) trigger — the database is the enforcer,
 * this only drives copy and pre-emptive UI disabling.
 *
 * One number for everybody — contributing to Ponder unlocks nothing, so
 * there is no tier for this to vary by. */
export function maxActiveThreadsForUser(): number {
  return maxActiveThreads();
}

export class ThreadLimitError extends Error {
  constructor(max: number = maxActiveThreads()) {
    super(
      `You can have ${max} threads running at once. Pause or conclude one to start another.`,
    );
    this.name = "ThreadLimitError";
  }
}

/**
 * Recognise the cap trigger's exception so the UI can explain it rather than
 * showing a raw Postgres message. Matched on the message text because a
 * plpgsql `raise` surfaces through PostgREST as a generic check_violation.
 */
function asThreadLimitError(error: { message?: string; code?: string }): Error {
  if (error?.message?.includes("Thread limit reached")) return new ThreadLimitError();
  return error as Error;
}

async function clearFocus(): Promise<void> {
  const { error } = await supabase
    .from("topics")
    .update({ focus: false })
    .eq("focus", true);
  if (error) throw error;
}

export async function setFocusTopic(topicId: string): Promise<void> {
  await clearFocus();
  const { error } = await supabase
    .from("topics")
    .update({ focus: true })
    .eq("id", topicId);
  if (error) throw error;
}

/** Clear the focus topic entirely — the daily notification then rotates among
 * active topics. */
export async function clearFocusTopic(): Promise<void> {
  await clearFocus();
}

export async function setTopicStatus(
  topicId: string,
  status: "active" | "paused",
): Promise<void> {
  const { error } = await supabase
    .from("topics")
    .update({ status })
    .eq("id", topicId);
  if (error) throw asThreadLimitError(error);
}

/** How many threads are currently active — used to disable "New thread"
 * before the user has typed anything, rather than failing at submit. */
export async function countActiveTopics(): Promise<number> {
  const { count, error } = await supabase
    .from("topics")
    .select("id", { count: "exact", head: true })
    .eq("status", "active");
  if (error) throw error;
  return count ?? 0;
}

/** Conclude a topic, optionally capturing a closing reflection.
 *
 * The closing note is attached to the topic's most recent daily entry so it
 * surfaces in the Journal rollup. It MUST be written before the status flips
 * to 'concluded' — a DB trigger blocks notes on concluded topics. If the topic
 * has no entries yet, there's nowhere to attach the note, so it's skipped and
 * the caller is told (so we never silently drop the user's words).
 *
 * The full guided looking-back reflection (timeline + synthesis) lands in step 6;
 * this is the basic confirm-with-closing-note flow. */
export async function concludeTopic(
  topicId: string,
  opts: { closingNote?: string; skipSynthesis?: boolean } = {},
): Promise<{ noteSaved: boolean }> {
  const body = opts.closingNote?.trim();
  let noteSaved = false;

  if (body) {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) throw new Error("Not signed in");

    const { data: latest, error: eLatest } = await supabase
      .from("daily_entries")
      .select("id")
      .eq("topic_id", topicId)
      .order("date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (eLatest) throw eLatest;

    if (latest) {
      const { error: eNote } = await supabase.from("notes").insert({
        entry_id: latest.id,
        topic_id: topicId,
        user_id: userId,
        body,
      });
      if (eNote) throw eNote;
      noteSaved = true;
    }
  }

  // Auto-generate a looking-back synthesis on conclusion unless the flow already
  // produced one. Best-effort: a topic with nothing to synthesize (or an
  // undeployed function) must never block the conclusion itself.
  if (!opts.skipSynthesis) {
    try {
      await generateSynthesis(topicId, "conclusion");
    } catch {
      /* non-fatal */
    }
  }

  const { error } = await supabase
    .from("topics")
    .update({ status: "concluded" })
    .eq("id", topicId);
  if (error) throw error;

  return { noteSaved };
}

export interface TopicStats {
  entryCount: number;
  lastNote: Note | null;
}

/** Entry counts + latest note per topic, aggregated client-side (single-user
 * data volumes make this fine; move to an RPC if it ever isn't). */
export async function fetchTopicStats(): Promise<Record<string, TopicStats>> {
  const [{ data: entryRows, error: e1 }, { data: noteRows, error: e2 }] =
    await Promise.all([
      supabase.from("daily_entries").select("topic_id"),
      supabase
        .from("notes")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200),
    ]);
  if (e1) throw e1;
  if (e2) throw e2;
  const stats: Record<string, TopicStats> = {};
  for (const row of entryRows ?? []) {
    const id = row.topic_id as string;
    stats[id] = stats[id] ?? { entryCount: 0, lastNote: null };
    stats[id].entryCount += 1;
  }
  for (const note of (noteRows ?? []) as Note[]) {
    stats[note.topic_id] = stats[note.topic_id] ?? { entryCount: 0, lastNote: null };
    if (!stats[note.topic_id].lastNote) stats[note.topic_id].lastNote = note;
  }
  return stats;
}

export async function fetchTopicEntries(topicId: string): Promise<DailyEntry[]> {
  const { data, error } = await supabase
    .from("daily_entries")
    .select("*")
    .eq("topic_id", topicId)
    .order("date", { ascending: false });
  if (error) throw error;
  return data as DailyEntry[];
}

export async function fetchTopicNotes(topicId: string): Promise<Note[]> {
  const { data, error } = await supabase
    .from("notes")
    .select("*")
    .eq("topic_id", topicId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data as Note[];
}

// ------------------------------------------------------------ account backup
//
// Anonymous accounts exist only as long as the device keeps its session. These
// helpers let a user attach an email so the account survives a lost/replaced
// device, and restore it elsewhere. All flows use 6-digit OTP codes rather than
// magic links, so nothing depends on native deep-linking.

/** Attach an email to the current (anonymous) account. Sends a confirmation
 * code to that address; the account stays anonymous until confirmEmailBackup. */
export async function startEmailBackup(email: string): Promise<void> {
  const { error } = await supabase.auth.updateUser({ email: email.trim() });
  if (error) throw error;
}

/** Confirm the email attached by startEmailBackup with the emailed code. On
 * success the account becomes permanent (is_anonymous flips to false). */
export async function confirmEmailBackup(email: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: token.trim(),
    type: "email_change",
  });
  if (error) throw error;
}

/** Restore an already-backed-up account on a new device. Sends a login code;
 * shouldCreateUser:false so a typo can't silently mint a new empty account. */
export async function startRestore(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim(),
    options: { shouldCreateUser: false },
  });
  if (error) throw error;
}

/** Complete a restore with the emailed login code — swaps the throwaway
 * anonymous session on this device for the real account. */
export async function confirmRestore(email: string, token: string): Promise<void> {
  const { error } = await supabase.auth.verifyOtp({
    email: email.trim(),
    token: token.trim(),
    type: "email",
  });
  if (error) throw error;
}

// --------------------------------------------------------------- deletion

/**
 * Delete a single note.
 *
 * RLS ("notes_delete_own") already restricts this to the caller's own rows, so
 * no extra ownership check is needed here.
 */
export async function deleteNote(noteId: string): Promise<void> {
  const { error } = await supabase.from("notes").delete().eq("id", noteId);
  if (error) throw error;
}

/**
 * Delete a thread and everything attached to it.
 *
 * Only the `topics` row is deleted; daily_entries, notes and syntheses all
 * reference topics with `on delete cascade`, so Postgres removes them. That
 * cascade runs with the FK's privileges, not the caller's — which is why this
 * works even though daily_entries and syntheses have no client delete policy.
 *
 * Nothing gates this. It was never gated by the old paywall either — access
 * to the user's own writing is not a thing to sell.
 */
export async function deleteTopic(topicId: string): Promise<void> {
  const { error } = await supabase.from("topics").delete().eq("id", topicId);
  if (error) throw error;
}

/**
 * Permanently delete the account and all its data, then clear the local
 * session. Required by App Store guideline 5.1.1(v).
 *
 * The edge function does the work with the service role (only it can remove the
 * auth.users row). We sign out afterwards so the app boots into a clean state
 * and `ensureSession` mints a fresh anonymous account on next launch.
 */
export async function deleteAccount(): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Not signed in");

  const res = await fetch(`${FUNCTIONS_URL}/delete-account`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error ?? `Could not delete account (${res.status})`);
  }

  // The auth row is gone, so the local token is already dead — this just clears
  // the persisted session. `scope: "local"` avoids a doomed server round-trip.
  await supabase.auth.signOut({ scope: "local" });
}

// -------------------------------------------------------------- synthesis

export async function fetchSyntheses(topicId: string): Promise<Synthesis[]> {
  const { data, error } = await supabase
    .from("syntheses")
    .select("*")
    .eq("topic_id", topicId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data as Synthesis[];
}

/** Invoke the synthesize edge function with the user JWT (function restricts
 * user tokens to their own topic). kind 'on_demand' for "What's emerging?",
 * 'conclusion' for the looking-back reflection during the conclusion flow. */
export async function generateSynthesis(
  topicId: string,
  kind: SynthesisKind = "on_demand",
): Promise<Synthesis> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Not signed in");

  const res = await fetch(`${FUNCTIONS_URL}/synthesize`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ topic_id: topicId, kind }),
  });
  const payload = await res.json().catch(() => ({}));
  if (res.status === 429) throw await quotaRefused(payload);
  if (!res.ok) {
    throw new Error(payload.message ?? payload.error ?? `Synthesis failed (${res.status})`);
  }
  return payload.synthesis as Synthesis;
}

/**
 * Turn a server 429 into a typed error.
 *
 * Two quite different things arrive as 429 and the reason code separates
 * them. `spend_tripwire` means the server's runaway guard fired — an
 * operational fault, nothing the user did and nothing they can fix, so it is
 * surfaced as a delay. The synthesis reasons are per-thread and per-tier;
 * conflating them would have the app tell a user to support Ponder to fix
 * something supporting cannot fix.
 *
 * The entitlement is re-synced on the tier-dependent reasons only, in case a
 * entitlement status was stale locally.
 */
async function quotaRefused(payload: {
  error?: string;
  message?: string;
  next_available_at?: string;
}): Promise<Error> {
  const reason = payload?.error ?? "unknown";
  if (reason === "spend_tripwire") return new GenerationDelayedError();
  await refreshEntitlement();
  return new SynthesisQuotaError(
    payload?.message ?? "Synthesis isn't available right now.",
    reason,
    payload?.next_available_at ?? null,
  );
}

/** On-demand generation for a topic missing today's entry (new topic created
 * mid-day, or cron hasn't run). Invokes the edge function with the user JWT —
 * the function restricts user tokens to their own topics. */
export async function generateEntryNow(topicId: string): Promise<void> {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Not signed in");

  const res = await fetch(`${FUNCTIONS_URL}/generate-entry`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ topic_id: topicId }),
  });
  const payload = await res.json().catch(() => ({}));
  if (res.status === 429) throw await quotaRefused(payload);
  // Any server-side failure here is operational, not something the user did.
  // The raw reason ("model output unusable after retry", a 502 upstream) is
  // useless to them and alarming, so all of them become the same "running
  // late" message. The real reason is already in generation_failures.
  if (!res.ok) throw new GenerationDelayedError();
  const result = payload.results?.[0];
  if (result?.status === "failed") throw new GenerationDelayedError();
}

// ---------------------------------------------------------------- reports

/**
 * File a report against AI-generated content.
 *
 * Google Play's Generative AI policy requires an in-app path for users to flag
 * offensive output without leaving the app. Never gated — safety reporting
 * must never sit behind anything.
 *
 * Upserts on (user_id, item) so re-reporting the same item corrects the
 * existing report rather than creating duplicates.
 */
export async function submitContentReport(args: {
  target: ReportTarget;
  entry?: DailyEntry;
  synthesis?: Synthesis;
  reason: ReportReason;
  detail?: string;
}): Promise<ContentReport> {
  const { target, entry, synthesis, reason, detail } = args;

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("Not signed in");

  if (target === "daily_entry" && !entry) throw new Error("Missing entry");
  if (target === "synthesis" && !synthesis) throw new Error("Missing synthesis");

  // Snapshot what the user actually saw — entries can be regenerated or
  // removed, and a report without its content is not actionable.
  const reported_content =
    target === "daily_entry" && entry
      ? {
          verse_ref: entry.verse_ref,
          verse_text: entry.verse_text,
          thought: entry.thought,
          illustration: entry.illustration,
          ponder: entry.ponder,
          prayer_prompts: entry.prayer_prompts,
          entry_type: entry.entry_type,
        }
      : synthesis
        ? { kind: synthesis.kind, content: synthesis.content }
        : null;

  const row = {
    user_id: userId,
    target,
    entry_id: target === "daily_entry" ? (entry?.id ?? null) : null,
    synthesis_id: target === "synthesis" ? (synthesis?.id ?? null) : null,
    reason,
    detail: detail?.trim() ? detail.trim() : null,
    reported_content,
  };

  const { data, error } = await supabase
    .from("content_reports")
    .upsert(row, {
      onConflict: target === "daily_entry" ? "user_id,entry_id" : "user_id,synthesis_id",
    })
    .select()
    .single();
  if (error) throw error;
  return data as ContentReport;
}

// ----------------------------------------------------------------- export

/**
 * Export the whole journal as Markdown.
 *
 * Deliberately NOT entitlement-gated, and deliberately reachable from the
 * paywall itself. Ponder is a hard paywall after the trial, which is a
 * defensible call for generated content — but the notes are the user's own
 * writing, and locking a person out of words they wrote is a different thing
 * from locking them out of a feature. This is the escape hatch: no
 * subscription, no network round-trip beyond their own rows, no negotiation.
 *
 * It also happens to be the cheapest possible answer to an App Review
 * question about data access, and to a support email that would otherwise be
 * a manual database dump.
 */
export async function exportJournalMarkdown(): Promise<string> {
  const [topics, entries, notes] = await Promise.all([
    supabase.from("topics").select("*").order("created_at", { ascending: true }),
    supabase.from("daily_entries").select("*").order("date", { ascending: true }),
    supabase.from("notes").select("*").order("created_at", { ascending: true }),
  ]);
  if (topics.error) throw topics.error;
  if (entries.error) throw entries.error;
  if (notes.error) throw notes.error;

  const allTopics = (topics.data ?? []) as Topic[];
  const allEntries = (entries.data ?? []) as DailyEntry[];
  const allNotes = (notes.data ?? []) as Note[];

  const notesByEntry = new Map<string, Note[]>();
  for (const n of allNotes) {
    const list = notesByEntry.get(n.entry_id) ?? [];
    list.push(n);
    notesByEntry.set(n.entry_id, list);
  }

  const out: string[] = [
    "# Ponder journal",
    "",
    `Exported ${new Date().toISOString().slice(0, 10)}`,
    "",
  ];

  for (const t of allTopics) {
    out.push(`## ${t.title}`, "");
    if (t.description) out.push(t.description, "");
    out.push(
      `*${t.status}${t.concluded_at ? ` — concluded ${t.concluded_at.slice(0, 10)}` : ""}*`,
      "",
    );
    if (t.seed_verse_ref) out.push(`Origin passage: ${t.seed_verse_ref}`, "");

    for (const e of allEntries.filter((e) => e.topic_id === t.id)) {
      out.push(
        `### ${e.date} — ${e.verse_ref}${e.entry_type === "challenge" ? " (challenge)" : ""}`,
        "",
        `> ${e.verse_text}`,
        "",
        e.thought,
        "",
        e.illustration,
        "",
        "**Ponder**",
        ...e.ponder.map((q) => `- ${q}`),
        "",
        "**Pray**",
        ...e.prayer_prompts.map((p) => `- ${p}`),
        "",
      );
      const entryNotes = notesByEntry.get(e.id) ?? [];
      if (entryNotes.length) {
        out.push("**Your notes**", "");
        for (const n of entryNotes) {
          out.push(`- *${n.created_at.slice(0, 10)}* — ${n.body}`);
        }
        out.push("");
      }
    }
  }

  return out.join("\n");
}
