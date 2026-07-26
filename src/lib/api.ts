import { supabase, FUNCTIONS_URL } from "./supabase";
import { assertEntitled } from "./entitlements";
import type {
  DailyEntry,
  Note,
  Profile,
  Synthesis,
  SynthesisKind,
  Topic,
} from "./types";

const PROFILE_COLS = "id, timezone, notification_hour, challenge_frequency";

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
  patch: Partial<Pick<Profile, "timezone" | "notification_hour" | "challenge_frequency">>,
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

/** The device's IANA timezone (e.g. 'Australia/Melbourne'), or null if unknown. */
function deviceTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.length ? tz : null;
  } catch {
    return null;
  }
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

export async function createTopic(input: {
  title: string;
  description: string;
  focus: boolean;
}): Promise<Topic> {
  const { data: userData } = await supabase.auth.getUser();
  const userId = userData.user?.id;
  if (!userId) throw new Error("Not signed in");
  if (input.focus) await clearFocus();
  const { data, error } = await supabase
    .from("topics")
    .insert({ user_id: userId, ...input })
    .select()
    .single();
  if (error) throw error;
  return data as Topic;
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
  if (error) throw error;
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
  assertEntitled("synthesis");
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
  if (!res.ok) {
    throw new Error(payload.error ?? `Synthesis failed (${res.status})`);
  }
  return payload.synthesis as Synthesis;
}

/** On-demand generation for a topic missing today's entry (new topic created
 * mid-day, or cron hasn't run). Invokes the edge function with the user JWT —
 * the function restricts user tokens to their own topics. */
export async function generateEntryNow(topicId: string): Promise<void> {
  assertEntitled("entry_generation");
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
  if (!res.ok) {
    throw new Error(payload.error ?? `Generation failed (${res.status})`);
  }
  const result = payload.results?.[0];
  if (result?.status === "failed") {
    throw new Error(result.error ?? "Generation failed");
  }
}
