-- Find generated content that states or implies how long a reader has been on
-- a thread. Entries must never do this: the model does not know the reader's
-- real timeline, so every such claim is fabricated (see the "no duration
-- claims" rule, 3 Sep 2026). Prompt-side fix is deployed; this finds the
-- backlog written before it.
--
-- Two ways a row is flagged:
--   phrase — a high-confidence phrase, no context needed
--   span2p — a counted span ("after three months") in a sentence that also
--            addresses the reader. The second-person requirement is what
--            keeps biblical spans out: "for forty years clothing did not wear
--            out" and "whether the cloud settled for two days or a full year"
--            are legitimate and must NOT be rewritten.
--
-- Deliberately NOT flagged, because they read as "recently" rather than as a
-- length claim, and flagging them triples the rewrite bill for no gain:
--   lately / by now / day after day / "you have been waiting"
--
-- Counts at time of writing (3 Sep 2026):
--   daily_entries  26 of 477 flagged (18 phrase, 10 span2p), 4 have notes
--   entry_pool    339 of 1387 live rows flagged (295 phrase, 80 span2p)
--
-- No network to supabase.co from the Cowork shells — run this in the
-- dashboard SQL editor.

with e as (
  select d.id::text as id, 'daily_entries' as tbl, d.topic_id::text as parent, d.date::text as when_,
         concat_ws(' ', d.thought, d.illustration, array_to_string(d.ponder,' '), array_to_string(d.prayer_prompts,' ')) as body
    from daily_entries d
  union all
  select p.id::text, 'entry_pool', p.theme_id::text, p.created_at::date::text,
         concat_ws(' ', p.thought, p.illustration, array_to_string(p.ponder,' '), array_to_string(p.prayer_prompts,' '))
    from entry_pool p
   where p.retired = false
),
sent as (
  select e.tbl, e.id, e.parent, e.when_, s
    from e cross join lateral regexp_split_to_table(e.body, '[.!?]\s+') as s
),
hi(rx) as (values
  ('\mday\s+[0-9]+\M'),
  ('\mlong haul\M'),
  ('\mearly days\M'),
  ('\ma while now\M'),
  ('\mall this time\M'),
  ('\mall these (days|weeks|months|years)\M'),
  ('\mthese past\M'),
  ('\m[0-9]+(st|nd|rd|th)\s+(day|week|month|year)\M'),
  ('\mfor so long\M'),
  ('\m(weeks|months|years) of (waiting|praying|prayer|silence|asking|listening|wrestling)\M')
),
span(rx) as (values
  ('\m(after|for|over|through|across|nearly|almost|another|these|those|past|last)\s+(the\s+)?(past\s+|last\s+)?(a\s+|an\s+)?([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|hundred|many|several|countless)\s+(day|days|week|weeks|month|months|year|years)\M')
),
flagged as (
  select tbl, id, parent, when_, 'phrase' as why, s
    from sent join hi on sent.s ~* hi.rx
  union
  select tbl, id, parent, when_, 'span2p', s
    from sent, span
   where sent.s ~* span.rx and sent.s ~* '\m(you|your|yours|thread)\M'
)
select tbl, id, parent, when_,
       string_agg(distinct why, ',') as why,
       left(string_agg(distinct s, ' || '), 400) as evidence
  from flagged
 group by tbl, id, parent, when_
 order by tbl, when_ desc;

-- Counts only:
-- select tbl, why, count(distinct id) from flagged group by 1,2 order by 1,2;
