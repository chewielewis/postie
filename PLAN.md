# Postie — Plan

> Status: **ingest engine rebuilt in Python** (`ingestor/`, on `main`). Web
> dashboard not started — pick up at Phase 1. Last revised 2026-06-04.

## What Postie is

A system for **assistant editors** that processes, transcodes, and moves shot
video media into **Avid Media Composer**, and keeps a **database of all material
that is shot**.

The product has two halves that meet only at a shared **Supabase** database:

- **`ingestor/` (`python -m postie`) — the ingest engine.** A zero-dependency
  Python 3.9+ program (stdlib only: `urllib`, `http.server`, `subprocess`;
  ffmpeg/ffprobe on PATH) that runs a local HTTP server + browser UI on `:4321`.
  Flow: **session** → **stories (slugs)** → **scan card** (ffprobe metadata +
  preview JPEGs) → **copy + verify** (BLAKE2b checksummed backup, resumable) →
  **ingest** (relay reconciliation → DNxHR LB transcode to `_staging` → move into
  AvidMediaFiles) → per-story **ALE** (Avid) + **FCPXML** (Resolve). Handles
  relay/spanned clips. Sets TapeID = clip name (no Avid Bulk Edit). Per-clip
  checkpoints `pending→copied→read→transcoded→moved` in Supabase, so an
  interrupted card resumes and a single card can be redone. Needs only Python +
  FFmpeg — chosen so the Windows ingest box needs nothing else.
- **`cli/` (`postie-rushes`, Node) — RETAINED FOR REFERENCE, deprecated.** The
  original zero-dep Node ingest engine. Superseded by `ingestor/`; kept in the
  repo (not deleted) for safety/reference. Other collaborators may still touch
  it — don't remove it without asking.
- **`src/` (Next.js web app)** — today a thin per-show "tools hub" (filename
  generator, downloads, rushes docs, coming-soon stubs). **To be remade into the
  ingest dashboard + media database browser** described below.

## Goal of the web remake

Turn the web app into the **ingest dashboard + media database** for AEs, backed
by the same Supabase tables the ingestor writes (`shows → slugs → sessions →
cards → clips`). The engine is now Python; the web half is **engine-agnostic** —
it reads Supabase and doesn't care what wrote the rows. Decided with the user:

- Web app = **media database browser + live ingest dashboard**.
- **Thumbnails: yes** — the ingestor uploads preview JPEGs to Supabase Storage so
  the web can show them.

## The core architectural constraint

The deployed web app **cannot reach the ingest machine**. Preview JPEGs and
DNxHR proxies live on local/Avid disks; `clips.preview_path` is a local
filesystem path. Therefore:

- **Thumbnails** require the ingestor to upload preview JPEGs to **Supabase
  Storage** during scan and store the resulting URL on the clip row.
- **Live ingest monitoring** requires the ingestor to write progress to Supabase
  as it runs. It already writes per-clip `status` through the lifecycle; the web
  reads it via Supabase **Realtime** or short polling. (Local SSE stays for the
  ingest machine's own browser UI.)

## Prerequisites (Supabase — controlled by the user / requires the key)

- `ingestor/.env` holds `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (gitignored).
  Use it to apply migrations and to create the web app's `.env.local`. **Do not
  commit secrets.**
- The web client-side Realtime also needs `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from
  the Supabase dashboard) — not currently stored anywhere in the repo.
- New schema/Storage to add (write the SQL; user applies it or grants DB access):
  - Storage bucket `previews` (public or signed URLs).
  - `sessions.status` (e.g. `active|complete`) + progress counts
    (clips_total / clips_done).
  - `clips.status` is already written through the whole ingest lifecycle by the
    Python ingestor (`pending→copied→read→transcoded→moved`).

## Phases

### Phase 1 — Web data layer
- Server-side typed Supabase access in `src/lib` (service-role): shows,
  stories/slugs, sessions, cards, clips, plus aggregate stats.
- App-router server components fetch directly (Next 16: async server components,
  `params` is a Promise). **Read the bundled Next 16 docs first** (see below).

### Phase 2 — Media library browser
- `/[show]/library` — searchable grid of every clip ever shot. Filters: story,
  session/date, camera, codec, status; text search on clip name. Clip detail:
  timecodes, relay info, preview.
- Ships metadata-first; thumbnails light up once Phase 3 uploads land.

### Phase 3 — Ingestor enhancements (Python `ingestor/`)
- Upload preview JPEGs to Supabase Storage on scan; store URL on the clip row.
  (Today thumbnails are extracted locally and served over the local UI only.)
- Add `sessions.status` + clip counts to the progress the ingestor already
  writes, so the deployed web can show live session state (not just local SSE).
- (Already done in the rebuild: browser UI, SSE, BLAKE2b verified copy, relay
  concat, GPU decode/LUT detection, per-clip checkpoints, ALE + FCPXML.)

### Phase 4 — Live ingest dashboard
- `/[show]` dashboard: in-progress sessions with per-clip/card progress (Realtime
  or polling), recent sessions, overall counts (clips, stories, cards).

### Phase 5 — Navigation shell + utilities
- Consistent show layout: persistent nav (Dashboard · Library · Sessions ·
  Tools), shared header / back pattern, mobile. Keep filename generator,
  downloads, and the rushes **install** page.
- Drop the dead `uploads` / `rundown` / `timecode-notes` stubs; fold
  "deliverables" into the DB later.

### Phase 6 — Verify
- `npm run build`, run dev, click through golden path + edge cases.
- Note: real ingest and live Supabase data can't be exercised without
  credentials/hardware — state that explicitly rather than claiming it works.

## Suggested order
1 → 2 (usable browser fast) → 3 → 4 (live) → 5 → 6.

## Open decisions for the next session
1. Apply the Supabase SQL/bucket yourself, or grant DB access so the agent can?
2. Source the `NEXT_PUBLIC_SUPABASE_ANON_KEY` for client Realtime (dashboard)
   when reaching Phase 4.

## Key files / reference
- Ingest engine: `ingestor/postie/` (`pipeline`, `server`, `supa`, `media`,
  `copy`, `relay`, `transcode`, `ale`, `gpu`, `timecode`), `ingestor/README.md`.
- Deprecated reference engine: `cli/rushes.mjs`, `cli/lib/*.mjs`.
- Web: `src/app/[show]/*`, `src/lib/{supabase,auth}.ts`, `src/config/shows.ts`,
  `src/app/globals.css`.
- **Before writing any Next.js code, read the bundled Next 16 docs** under
  `node_modules/next/dist/docs/01-app/` (per `AGENTS.md` — this is a modified
  Next with breaking changes). On the Windows ingest box Node/npm aren't on PATH:
  use `& "C:\Program Files\nodejs\npm.cmd"`.
