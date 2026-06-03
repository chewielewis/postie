# Postie Ingestor

CLI-driven camera-card ingest for Avid Media Composer and DaVinci Resolve.
Scans cards, verified-copies originals to backup, reconciles spanned (relay)
clips, transcodes to DNxHR LB MXF, organises into AvidMediaFiles, and writes
per-story ALE + FCPXML.

Pure Python standard library — the only external requirements are **Python 3.9+**
and **ffmpeg/ffprobe** on `PATH`. No `pip install` needed.

## Setup

```bash
cp .env.example .env       # fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
# drop show LUTs into luts/ (e.g. slog3_to_709.cube) — see luts/README.md
```

## Run

```bash
python -m postie --show PGHI            # opens http://localhost:4321
python -m postie --show PGHI --port 5000
```

Then drive the browser UI through the three pipeline steps:

1. **Session setup** — shoot date, log format, output root, backup drive, Avid path, fps.
2. **Scan & copy cards** — insert a card, scan (probe + LUT thumbnails), assign
   stories per clip, then *Copy + verify → add card*. Eject once copy completes.
3. **Transcode & deliver** — reconciles relays across all cards, transcodes to
   DNxHR LB, moves proxies into AvidMediaFiles, writes ALE + FCPXML per story.

## How it works

- **Naming:** `MMDD_SLUG_CAM<X>_CARD<NNN>_<OriginalName>` — TapeID = Name, so no
  Avid Bulk Edit. Collisions (GoPro/drone) are disambiguated automatically.
- **Verified copy:** BLAKE2b checksum on every backup copy; identical existing
  copies are skipped so an interrupted card resumes without re-copying.
- **Relay (spanned) clips:** detected by TC continuity + wall-clock, concatenated
  into one proxy named after part 1; the ALE shows the combined duration.
- **GPU:** NVENC/QSV/AMF/VideoToolbox detected at runtime for decode + LUT
  filtering, CPU fallback. (DNxHR encode is always CPU — no hardware encoder.)
- **Checkpoints:** each clip advances `pending → copied → read → transcoded → moved`
  in Supabase. Re-running ingest skips finished clips; a single card can be
  reset and reprocessed without touching the rest.

## Layout

```
postie/
  __main__.py     entry point
  settings.py     env + presets
  supa.py         Supabase REST client + checkpoint state machine
  media.py        ffprobe scan + thumbnails
  copy.py         verified (checksummed) copy
  relay.py        spanned-clip detection
  transcode.py    DNxHR LB transcode + relay concat + move-to-Avid
  ale.py          ALE + FCPXML builders
  timecode.py     NDF + drop-frame TC math
  gpu.py          runtime encoder detection
  pipeline.py     8-stage orchestration
  server.py       http.server UI + SSE
  web/index.html  browser UI
```
