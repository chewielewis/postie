# Postie — Remake Plan

> Status: **planning** (no implementation started). Written 2026-05-28. Pick up at Phase 0.

## What Postie is

A system for **assistant editors** that processes, transcodes, and moves shot video media
into **Avid Media Composer**, and keeps a **database of all material that is shot**.

The product has two halves that meet only at a shared **Supabase** database:

- **`cli/` (`postie-rushes`)** — the ingest engine. A single zero-dependency Node script that
  runs a local HTTP server + browser UI on `:4321`. Flow: **session** → **stories (slugs)** →
  **scan card** (ffprobe metadata + preview JPEGs) → **queue** → **ingest** (backup originals →
  DNxHR LB transcode to `_staging/<date>` → `commitSessionToAvid` moves the folder into
  AvidMediaFiles) → per-story **ALE** (Avid) + **FCPXML** (Resolve). Handles relay/spanned clips.
  Sets TapeID = clip name (no Avid Bulk Edit). Needs only Node 18+ and FFmpeg.
- **`src/` (Next.js 16.2.6 web app)** — today a thin per-show "tools hub" (filename generator,
  downloads, rushes docs, coming-soon stubs). **To be remade into the ingest dashboard + media
  database browser** described below.

## Goal of the remake

Turn the web app into the **ingest dashboard + media database** for AEs, backed by the same
Supabase tables the CLI already writes (`shows → slugs → sessions → cards → clips`), and clean
up the repo into a proper monorepo. Decided with the user:

- Web app = **media database browser + live ingest dashboard**.
- **Thumbnails: yes** — the CLI will upload preview JPEGs to Supabase Storage so the web can show them.
- CLI structure stays a single backend+frontend Node process — **no Docker** (it must touch
  removable cards, the backup drive, the Avid SMB share, and system ffmpeg directly; Docker would
  only add friction). The one cleanup: extract the ~800-line inline-HTML UI out of `rushes.mjs`
  into static files under `cli/ui/` (still zero-dep, still one command).

## The core architectural constraint

The deployed web app **cannot reach the ingest machine**. Preview JPEGs and DNxHR proxies live on
local/Avid disks; `clips.preview_path` is a local filesystem path. Therefore:

- **Thumbnails** require the CLI to upload preview JPEGs to **Supabase Storage** during scan and
  store the resulting URL.
- **Live ingest monitoring** requires the CLI to write progress to Supabase as it runs
  (clip status `pending→transcoding→done`, card status, session status + counts). The web reads it
  via Supabase **Realtime** or short polling. Today that progress only streams over local SSE.

## Prerequisites (Supabase — controlled by the user / requires the key)

- `cli/.env` holds `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (gitignored). Use it to apply
  migrations and to create the web app's `.env.local`. **Do not commit secrets.**
- The web client-side Realtime also needs `NEXT_PUBLIC_SUPABASE_ANON_KEY` (from the Supabase
  dashboard) — not currently stored anywhere in the repo.
- New schema/Storage to add (write the SQL; user applies it or grants DB access):
  - Storage bucket `previews` (public or signed URLs).
  - `sessions.status` (e.g. `active|complete`) + progress counts (clips_total / clips_done).
  - Ensure `clips.status` is written through the whole ingest lifecycle.

## Phases

### Phase 0 — Monorepo + hygiene
- Add `"workspaces": ["cli"]` to root `package.json`. Keep `cli` **dependency-free**.
- Remove unused `better-sqlite3`, `drizzle-kit`, `drizzle-orm` from root deps
  (verified: imported nowhere; leftovers from the Supabase migration).
- Replace the boilerplate `README.md` with a real one (what Postie is, how to run both halves).
- Add a shared TS module describing the DB shape (`shows/slugs/sessions/cards/clips`) for the web.

### Phase 1 — Web data layer
- Server-side typed Supabase access in `src/lib` (service-role, mirroring `cli/lib/db.mjs` reads):
  shows, stories/slugs, sessions, cards, clips, plus aggregate stats.
- App-router server components fetch directly (Next 16: async server components, `params` is a Promise).

### Phase 2 — Media library browser
- `/[show]/library` — searchable grid of every clip ever shot. Filters: story, session/date,
  camera, codec, status; text search on clip name. Clip detail: timecodes, relay info, preview.
- Ships metadata-first; thumbnails light up once Phase 3 uploads land.

### Phase 3 — CLI enhancements
- Upload preview JPEGs to Supabase Storage on scan; store URL on the clip row.
- Write live progress to Supabase during ingest (clip/card/session status + counts).
- Extract the inline UI from `rushes.mjs` into `cli/ui/{index.html,app.js,styles.css}` served by
  the existing server. Stays zero-dependency (plain `fetch`, like the current REST client).

### Phase 4 — Live ingest dashboard
- `/[show]` dashboard: in-progress sessions with per-clip/card progress (Realtime or polling),
  recent sessions, overall counts (clips, stories, cards).

### Phase 5 — Navigation shell + utilities
- Consistent show layout: persistent nav (Dashboard · Library · Sessions · Tools), shared header /
  back pattern, mobile. Keep filename generator, downloads, and the rushes **install** page.
- Drop the dead `uploads` / `rundown` / `timecode-notes` stubs; fold "deliverables" into the DB later.

### Phase 6 — Verify
- `npm run build`, run dev, click through golden path + edge cases.
- Note: real ingest and live Supabase data can't be exercised without credentials/hardware — state
  that explicitly rather than claiming it works.

## Suggested order
0 → 1 → 2 (usable browser fast) → 3 → 4 (live) → 5 → 6.

## Open decisions for the next session
1. Apply the Supabase SQL/bucket yourself, or grant DB access so the agent can?
2. Source the `NEXT_PUBLIC_SUPABASE_ANON_KEY` for client Realtime (dashboard) when reaching Phase 4.

## Key files / reference
- CLI engine: `cli/rushes.mjs` (server + UI), `cli/lib/{db,ingest,formats,relay,tc}.mjs`.
- Web: `src/app/[show]/*`, `src/lib/{supabase,auth}.ts`, `src/config/shows.ts`, `src/app/globals.css`.
- **Before writing any Next.js code, read the bundled Next 16 docs** under
  `node_modules/next/dist/docs/01-app/` (per `AGENTS.md` — this is a modified Next with breaking
  changes). On this machine Node/npm aren't on PATH: use `& "C:\Program Files\nodejs\npm.cmd"`.
