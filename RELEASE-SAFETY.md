# Ponder — release safety

Ponder is live on both stores with real users and **no forced update**. Read this
before any schema change, edge function deploy, or release.

## 1. Never take away what a shipped client can read

No `revoke`, no per-column grants, no dropped columns, no removed policies on any
table the client reads. Every build ever installed is a permanent API consumer.

Postgres refuses `select *` when the role lacks SELECT on any column — this broke
every installed build on 25 Aug 2026 (migration `20260824000002`, `topics`).

Anything the reader must not see does not live on that row. It lives in a new
service-only table: RLS on, zero policies, `revoke all from anon, authenticated`.

## 2. Ship the data first, the code that reads it second

Two deploys, not one. Add the table or column and populate it. Confirm it is there.
Only then ship code that reads it. Rollback is then never a data migration.

Adding is safe. Removing and narrowing are not.

## 3. Edge function deploys are the dangerous ones — not app builds

An app build rolls out gradually and users choose to update. An edge function deploy
hits 100% of users instantly with no rollback.

So: deploy from a known commit, and verify the deployed copy matches the repo. The
deployed `generate-entry` was silently 14 lines behind HEAD once, which meant a fix
that existed in git was not actually live.

The repo is not evidence of what is deployed.

## Also worth knowing

- **Failures here are silent.** The nightly batch was dead for weeks in Aug 2026 and
  nothing alerted. Assume a broken path will not announce itself; check
  `generation_failures` and entry counts after any generation change.
- **The pool is a canary.** For content or prompt changes, retire unserved
  `entry_pool` rows, let the hourly top-up rebuild, and read some before they serve.
  Never hard-delete pool rows — `entry_pool_seen` references them; use `retired`.
- **One concern per commit.** Commit 26bd2f9 swept up an unrelated prompt change and
  its message does not mention it.
- **Confirm before pushing to main or deploying.** Always.
