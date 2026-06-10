# Postie — Plan

> Status: **ingest engine rebuilt in Python** (`ingestor/`, on `main`). Web
> dashboard not started — pick up at Phase 1. Last revised 2026-06-11.

## ✅ SOLVED (path proven in Avid): raw2bmx DNxHD OP-Atom + embedded tags

raw2bmx produces Avid OP-Atom media that **comes ONLINE in Avid and plays** —
the OP-Atom blocker is solved. The remaining design change is to drop the ALE as
the Avid relink vehicle and instead **embed the AE metadata directly in the MXF**
so clips self-populate with no relink. Findings this session, in order:

- **Install solved — no build.** BBC ships a prebuilt Windows binary,
  `bmx-win64-binary-1.6.zip` (github.com/bbc/bmx releases v1.6), unpacked +
  committed at `tools/bmx/1.6/bmx-win64-binary-1.6/bin/` (raw2bmx, bmxtranswrap,
  mxf2raw). Needs MSVC redistributable. The "vcpkg/CMake+MSVC build" assumption
  was wrong.
- **CRITICAL: bmx 1.6 supports DNxHD (VC-3) only, NOT DNxHR.** Proven 3 ways:
  bmxtranswrap dropped the DNxHR video ("unknown essence type"); raw2bmx --vc3
  errored in VC3EssenceParser (DNxHR frame-header byte 0x03, parser wants
  0x01/0x02); the compression-ID table holds only 1235–1260 (all DNxHD). So
  **Postie's proxy codec must change DNxHR LB → DNxHD 36** (CID 1253, 1080p
  ~36Mbps — the classic Avid offline proxy). 0527 footage is 1080p25 (ALE:
  VIDEO_FORMAT 1080 / FPS 25) so no downscale; general code must still guard
  non-1080/non-25 since DNxHD is HD-only at fixed rates.
- **Media verified ONLINE in Avid.** Built real clip
  `0527_COPAYMENTS_CAMA_CARD001_A096C002_260527FK` (re-encoded its quarantined
  DNxHR proxy → DNxHD 36 + 8 WAVs → raw2bmx) into `Z:\…\MXF\PGHI-E02.6`. Avid
  scanned it (wrote msmMMOB.mdb) and **dragging in the msmMMOB plays + links
  fine.** Atoms share one MaterialPackage + PhysicalSourcePackage UMID (correct
  V+A grouping); opatom UL `...10030000`; tape = clip name @ TC 03:05:29:09. The
  media is structurally identical to Avid's own OP-Atom (same track_number ULs,
  descriptor).
- **ALE auto-relink does NOT work — and that path is rejected.** Importing the
  ALE makes offline master clips that do not auto-link to the media; only a
  *manual* Clip→Relink would bind them, and **the user requires it to be
  automatic** (manual per-session relink is unacceptable). So the ALE is dropped
  as the Avid online vehicle.
- **THE AUTOMATIC SOLUTION: embed metadata in the MXF via raw2bmx `--tag`.**
  raw2bmx avid options: `--tag <name> <value>` (repeatable) adds a named Avid
  user-comment **column** to the MaterialPackage; `--comment <str>` →
  'Comments'; `--desc <str>` → 'Descript'; `--project <name>`; `--locator`.
  Rebuilt C002 into `Z:\…\MXF\PGHI-E02.7` with `--tag Slug COPAYMENTS --tag
  Shoot_Day 0527 --tag Camera A --tag Color Cyan --comment "…" --project PGHI`;
  confirmed the strings are written into the MXF (UTF-16). When Avid scans the
  folder the clip comes online **already carrying its columns — no ALE, no
  relink.** ⏳ Pending: user confirms the columns show in the Avid bin (use
  Bin→Choose Columns to reveal custom user columns the first time).
  Caveat: `--tag Color Cyan` makes a *column* "Color"="Cyan"; it does NOT set
  Avid's colored-label dot (separate attribute bmx can't write) — drop or keep
  as a plain column.

Working recipe (flags are `--clip`/`--tape`, NOT `--clip-name`):
`ffmpeg -i src -map 0:v:0 -c:v dnxhd -b:v 36M -pix_fmt yuv422p -r 25 v.dnxhd`;
per track `ffmpeg -i src -map 0:a:K -c copy aN.wav`; then
`raw2bmx -t avid -o <dir>\<clip> --clip <clip> --tape <clip> -y <tc> -f 25 --project <show> --tag Slug <slug> --tag Camera <cam> … --vc3 v.dnxhd --wave a1.wav … --wave aN.wav`.

### Pipeline wiring (next implementation step)
Rework `transcode.py` (`transcode_clip` + `transcode_relay_group`): encode DNxHD
elementary + per-track WAVs into staging, run raw2bmx into the `PGHI-E02.N` Avid
folder (atoms `<clip>_v1` + `<clip>_a1..aN`), then move/finalise all atoms
together. Map each clip's Supabase fields (slug, camera, shoot_day, relay_group,
start_tc) → `--tag`/`--tape`/`-y`. Carry over audio copy/byte-swap rules (now →
WAV), LUT, relay concat, per-clip checkpoints. **ALE for Avid becomes redundant**
(metadata is embedded); keep FCPXML for Resolve. Locate raw2bmx via a configured
path to `tools/bmx/.../raw2bmx.exe`.

---

## (resolved) Avid needs OP-Atom MXF, we write OP1a

Confirmed against a live Avid Media Composer scan of the 0527 COPAYMENTS media:
Avid rejects our clips ("not a valid/supported MXF File") because ffmpeg's
default `mxf` muxer writes **OP1a** (one interleaved file, no
`operational_pattern_ul`), while Avid Media Composer only indexes **OP-Atom**
(`operational_pattern_ul=...10030000`). DNxHR/PCM data is fine — wrong container.

**Findings 2026-06-04 (research done):** ffmpeg's `mxf_opatom` writes a valid
OP-Atom container (`...10030000`, Avid scans it) and sets timecode, BUT cannot
set the `material_package_name`/reel/tape — the muxer exposes no such option and
`-metadata reel_name`/`material_package_name` are ignored at format AND stream
level. So Avid can't relink the ALE by TapeID with pure ffmpeg. The right tool is
**bmx `raw2bmx`** (bmxlib) — wraps a DNxHR elementary stream + WAV/PCM into Avid
OP-Atom with `--clip-name`, `--tape-name`, and groups V+A into one master clip.
Not installed; no winget package (the "BMX" winget hit is Desire2Learn). Needs a
prebuilt Windows binary or a CMake/MSVC build of bmxlib.

Two paths: (A) cheap test — make ffmpeg OP-Atom atoms (TC only) and scan in Avid
to see how far it gets (scan ok? TC relink?); (B) adopt raw2bmx as the wrapper
stage. Likely B for a real relink.

**RESULT of path A (tested live in Avid, 2026-06-04):** OP-Atom atoms in
`PGHI-E02.5` SCAN fine (no "invalid MXF") and the ALE master clip imports with
the correct track layout (e.g. 4 tracks for B-cam) — but **media stays OFFLINE**;
no tape name → Avid can't relink, timecode alone doesn't bridge it. **Decision:
go path B (raw2bmx).** ffmpeg-only is confirmed insufficient.

**PROOF from an Avid bin export (`X:\PGHI_2026 Bin2.ALE`, 2026-06-04):** the
OP-Atom atoms scan fine (DNxHR LB, correct TC, on Z:) but come in **nameless**
(`Name=msmMMOB.NN`, i.e. blank material_package_name), **tapeless** (empty Tape
column), and **ungrouped** (12 separate single-track clips, not one V+A1..A8).
The ALE master clips (Tape=A096, correct TC) stay offline because the media has
no tape to match. So the media needs three fields ffmpeg's mxf_opatom WON'T
write: `material_package_name` (=clip name), a tape/reel, and a shared package to
group V+A. The earlier "ffmpeg worked" recipe is unrecoverable (user doesn't have
it; my -metadata/muxer-option tests all failed). **Conclusion: use raw2bmx** — it
sets `--clip-name`, `--tape-name`, and groups the atoms. Standby lifted.

### Next session: build the raw2bmx wrapper stage
1. Get `raw2bmx` (bmxlib) onto the Windows box — no winget pkg; needs a prebuilt
   binary or a vcpkg/CMake+MSVC build of github.com/bbc/bmx.
2. New transcode flow: ffmpeg encodes DNxHR → `.dnxhd` elementary + per-track
   `.wav` (lossless, same copy/byte-swap rules); then `raw2bmx --clip-name <clip>
   --tape-name <reel> -t avid -o <dir> --dnxhd ... <wavs>` → grouped Avid OP-Atom.
3. Folder `<COMPUTERNAME>.N` (PGHI-E02.N). Re-test relink in Avid.
Scratch test ALE: `Y:\Ingest\0527_COPAYMENTS_OPATOM_TEST.ale` (2 clips).

Fix path (verified ffmpeg can do it; needs building + an Avid relink test):
- Use `-f mxf_opatom`. OP-Atom = **one essence per file**: 1 video MXF + **one
  MXF per audio track** (A-cam → 1 + 8 = 9 files per clip). A 2-sec test wrote
  `...10030000`, matching Avid.
- **Open problem:** Avid groups the video + audio atoms into a single master clip
  via a shared SourcePackage/MobID. Separate ffmpeg runs may emit independent
  MobIDs → Avid won't pair them. Research how to make the atoms share package
  metadata (or how Avid relinks OP-Atom: reel/TapeID + TC + track), then verify a
  real relink in Avid.
- **Media folder convention is `<COMPUTERNAME>.<n>`** (machine = `PGHI-E02`, so
  `PGHI-E02.N`), NOT `Postie.1`. `drives.postie_media_dir` must target the
  computer-name folder. Avid increments `.N` as folders fill.
- Audio handling (copy/byte-swap, all tracks) and ALE/FCPXML track counts are
  already correct and carry over.

Also (smaller): `pipeline.run_ingest` swallows per-clip transcode failures — a
failed clip stays at its old proxy with status unchanged. Mark it `failed` so
`--status` surfaces it.

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

- **API keys use Supabase's new key system, not the legacy JWTs.** Dashboard →
  Settings → API Keys: **Publishable key** (`sb_publishable_…`, replaces `anon`,
  browser-safe) and **Secret key** (`sb_secret_…`, replaces `service_role`,
  server-only). The env var *names* are unchanged — `SUPABASE_SERVICE_ROLE_KEY`
  holds the `sb_secret_…` value, `NEXT_PUBLIC_SUPABASE_ANON_KEY` holds the
  `sb_publishable_…` value; the code just forwards the value as the apikey/Bearer.
  Gotcha: **the secret key is rejected for browser-origin user-agents** (anything
  sending a `Mozilla/…` UA, e.g. PowerShell `Invoke-RestMethod`) — use curl or the
  ingestor's stdlib `urllib` (UA `Python-urllib/…`), which are fine.
- `ingestor/.env` holds `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (gitignored).
  Templates committed: `ingestor/.env.example`, `.env.local.example`. **Do not
  commit secrets.** Connection verified 2026-06-04 against project
  `orriipbupxlozsdzoibv` (show PGHI; slugs CLIMATE/COPAYMENTS/HOIHO; 1 session;
  cards/clips empty).
- The web client-side Realtime also needs `NEXT_PUBLIC_SUPABASE_ANON_KEY` — the
  publishable key, now stored in `.env.local` (gitignored).
- Supabase CLI / direct Postgres connection are **deferred to Phase 3** (not
  installed). Current phases run entirely over the REST/Realtime API. When schema
  changes are needed, decide then: dashboard SQL editor vs. `npx supabase`
  migrations-as-code (needs `supabase login` + the DB password).
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
- Decided: a terminal monitor (`python -m postie --show PGHI --status [--watch]`,
  `postie/status.py`) covers monitoring **now**; the web dashboard is deliberately
  deferred until the ingest workflow itself is solid. Both read the same Supabase
  clip status, so they stay consistent.

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

## Parked for later — backfill Postie DB from Avid-created media
Goal: Postie's media DB should reflect **all** material, not just Postie's own
transcodes — register the existing Avid-created MXF into Supabase. Feasibility
confirmed: `ffprobe` reads `reel_name` (original TapeID), `timecode`,
`material_package_name`, `project_name`, duration, etc. straight from the MXF.

Key facts / gotchas:
- **Avid writes OP-Atom**: each clip = several MXF files (1 video + N audio
  atoms) sharing one `material_package_name`/`reel_name`. Group atoms by material
  package — file count ≠ clip count (e.g. `PGHI-E02__bg.1` had 1098 atoms).
- Source folders are Avid's managed `Avid MediaFiles\MXF\<workspace>.N` (detected
  as `avid_active` by `drives.detect()`); Postie's own transcodes now live in a
  separate `Postie.N` folder (`drives.postie_media_dir`).
- Two decisions before building: (1) how to model session-less media — synthetic
  "Avid backfill" session vs nullable `card_id`/`slug_id` + a `source`
  (`avid`|`postie`) column (schema change); (2) slug assignment — leave
  `UNASSIGNED` and tag in the web app, or infer from `project_name`/folder.
- Suggested first step: a **read-only** probe+group pass that prints the deduped
  clip list (counts per camera/date) with zero DB writes.

Note: the Python ingestor is proven end-to-end on real footage — the 0527
COPAYMENTS shoot (84 clips, 4 cards) ingested clean into `Postie.1` with ALE +
FCPXML, drives auto-detected (media `Z:` Nexis, project `Y:`).

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
