"""Pipeline orchestration — ties the eight stages together with per-clip
checkpointing so an interrupted session resumes from the last completed step.

Operator flow (browser-driven):

  scan_card    Stage 2/3  probe metadata + thumbnails from the inserted card
  commit_card  Stage 1    verified copy to backup, persist clips, detect relays
  run_ingest   Stage 5-7  transcode (relay-reconciled) -> AvidMediaFiles -> ALE

Checkpoint state lives on each clip's `status`:
  pending -> copied -> read -> transcoded -> moved
run_ingest skips any clip already at `moved`, so re-running resumes cleanly.
"""

import json
from pathlib import Path
from typing import Callable, Dict, List, Optional

from . import ale, media
from .copy import verified_copy, unique_name
from .relay import detect_relays
from .supa import at_or_past
from .transcode import transcode_clip, transcode_relay_group

Emit = Callable[[str, dict], None]


def _noop(_type: str, _data: dict) -> None:
    pass


# ---------------------------------------------------------------------------
# Stage 2/3 — scan a card (probe + thumbnails), no DB writes yet
# ---------------------------------------------------------------------------

def scan_card(session: dict, *, input_path: str, cam: str, card_num: int,
              default_slug: Optional[str], emit: Emit = _noop) -> List[dict]:
    out_root = Path(session["output_path"])
    date = session["date"]
    log_preset = session.get("log_preset") or "none"
    fps = session.get("fps") or "25"

    preview_dir = out_root / date / "_previews" / "CAM{}_CARD{}".format(
        cam.upper(), str(card_num).zfill(3))

    root = Path(input_path)
    if not root.exists():
        raise FileNotFoundError("Card path not found: {}".format(input_path))

    emit("log", {"message": "Scanning {}...".format(input_path)})
    files = media.scan_dir(root)
    emit("log", {"message": "Found {} file(s)".format(len(files))})

    seen: set = set()
    clips: List[dict] = []
    for f in files:
        emit("log", {"message": "  probing {}...".format(f.name)})
        try:
            clip = media.build_clip(f, cam=cam, card_num=card_num, date=date,
                                    slug=default_slug, fps_default=fps)
        except RuntimeError as e:
            emit("log", {"message": "  skipped ({})".format(e)})
            continue
        clip["name"] = unique_name(clip["name"], seen)
        clip["tape"] = clip["name"]

        thumb = media.extract_thumbnail(
            f, preview_dir / "{}.jpg".format(clip["name"]),
            log_preset=log_preset, duration_sec=clip["duration_sec"])
        clip["preview_path"] = str(thumb) if thumb else None

        clips.append(clip)
        emit("preview", clip)
    return clips


# ---------------------------------------------------------------------------
# Stage 1 — commit a scanned card: verified copy + persist + relay detect
# ---------------------------------------------------------------------------

def commit_card(supa, session: dict, *, input_path: str, cam: str, card_num: int,
                clips: List[dict], slug_assignments: Dict[str, str],
                emit: Emit = _noop) -> dict:
    backup_root = session.get("backup_path")
    date = session["date"]
    fps = session.get("fps") or "25"

    card = supa.add_card(session["id"], input_path=input_path, cam=cam, card_num=card_num)
    slugs = supa.get_slugs(session["show_id"])
    slug_id_by_name = {s["name"]: s["id"] for s in slugs}

    for clip in clips:
        # Verified copy to backup (Stage 1)
        if backup_root:
            dest = (Path(backup_root) / date / "CAM_{}".format(cam.upper())
                    / "CARD_{}".format(str(card_num).zfill(3)) / Path(clip["file_path"]).name)
            try:
                verified_copy(Path(clip["file_path"]), dest, emit)
                clip["backup_path"] = str(dest)
            except Exception as e:
                emit("log", {"message": "  backup failed for {}: {}".format(
                    Path(clip['file_path']).name, e)})

        # Persist (metadata read + copied → status 'read')
        slug_name = slug_assignments.get(clip["name"]) or clip.get("slug")
        slug_id = slug_id_by_name.get((slug_name or "").upper()) if slug_name else None
        clip["status"] = "read"
        row = supa.add_clip(card["id"], clip, slug_id)
        clip["id"] = row["id"]

    supa.update_card_status(card["id"], "copied")

    chains = detect_relays(supa, session["id"], fps)
    if chains:
        emit("log", {"message": "Relay: {} span(s) detected".format(len(chains))})

    return {"card_id": card["id"], "clip_count": len(clips), "relay_chains": len(chains)}


# ---------------------------------------------------------------------------
# Stage 5-7 — transcode, organise, ALE
# ---------------------------------------------------------------------------

def run_ingest(supa, session_id: str, emit: Emit = _noop) -> dict:
    session = supa.get_session_with_cards(session_id)
    if not session:
        raise RuntimeError("Session not found")

    fps = session.get("fps") or "25"
    output = session["output_path"]
    avid = session.get("avid_path")
    log_preset = session.get("log_preset") or "none"

    # Final relay pass with every card present.
    detect_relays(supa, session_id, fps)
    session = supa.get_session_with_cards(session_id)

    # Build relay group map across all cards.
    all_clips: List[dict] = []
    for card in session["cards"]:
        for clip in card["clips"]:
            all_clips.append({**clip, "cam": card["cam"], "card_num": card["card_num"]})
    relay_map: Dict[str, List[dict]] = {}
    for clip in all_clips:
        if clip.get("relay_group"):
            relay_map.setdefault(clip["relay_group"], []).append(clip)
    for parts in relay_map.values():
        parts.sort(key=lambda c: c.get("relay_part") or 1)

    opts = dict(output=output, avid=avid, log_preset=log_preset)

    for card in session["cards"]:
        clips = card["clips"]
        total = len(clips)
        emit("card-start", {"card_id": card["id"], "cam": card["cam"],
                            "card_num": card["card_num"], "total": total})

        for index, clip in enumerate(clips, start=1):
            if (clip.get("relay_part") or 0) > 1:
                emit("log", {"message": "[{}] relay part {} — merged into part 1".format(
                    clip["name"], clip["relay_part"])})
                supa.set_clip_status(clip["id"], "moved")
                continue

            if at_or_past(clip.get("status"), "moved") and clip.get("proxy_path"):
                emit("transcode", {"card_id": card["id"], "clip": clip["name"],
                                   "index": index, "total": total, "status": "done"})
                continue

            emit("transcode", {"card_id": card["id"], "clip": clip["name"],
                               "index": index, "total": total, "status": "started"})
            try:
                if clip.get("relay_group") and clip.get("relay_part") == 1:
                    parts = relay_map.get(clip["relay_group"], [clip])
                    proxy = transcode_relay_group(parts, emit=emit, **opts)
                    for p in parts[1:]:
                        supa.set_clip_status(p["id"], "moved")
                else:
                    proxy = transcode_clip(clip, emit=emit, **opts)
                supa.set_clip_status(clip["id"], "moved", proxy_path=proxy)
                emit("transcode", {"card_id": card["id"], "clip": clip["name"],
                                   "index": index, "total": total, "status": "done"})
            except Exception as e:
                emit("log", {"message": "Error on {}: {}".format(clip["name"], e)})

        supa.update_card_status(card["id"], "complete")
        emit("card-done", {"card_id": card["id"]})

    _write_relay_manifest(session, relay_map, output, emit)
    stories = _write_ales(supa, session_id, session, fps, output, emit)
    emit("done", {"stories": stories})
    return {"stories": stories}


def redo_card(supa, card_id: str, emit: Emit = _noop) -> None:
    """Reset a single card's clips to 'read' so the next ingest reprocesses it."""
    for clip in supa.get_clips(card_id):
        supa.set_clip_status(clip["id"], "read", proxy_path=None)
    supa.update_card_status(card_id, "copied")
    emit("log", {"message": "Card reset for reprocessing"})


def _write_relay_manifest(session, relay_map, output, emit: Emit) -> None:
    groups = [parts for parts in relay_map.values() if len(parts) > 1]
    if not groups:
        return
    manifest = {
        "session": session["id"], "date": session["date"],
        "relays": [{
            "relay_group": parts[0]["relay_group"],
            "parts": [{
                "relay_part": p.get("relay_part"),
                "clip_name": p["name"],
                "file_path": p.get("file_path"),
                "start_tc": p.get("start_tc"),
                "end_tc": p.get("end_tc"),
                "card": p.get("card_num"),
            } for p in parts],
        } for parts in groups],
    }
    out = Path(output)
    out.mkdir(parents=True, exist_ok=True)
    (out / "session-relays.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    emit("log", {"message": "Relay manifest: session-relays.json ({} group(s))".format(len(groups))})


def _write_ales(supa, session_id, session, fps, output, emit: Emit) -> List[dict]:
    story_map = supa.clips_by_slug(session_id)
    stories: List[dict] = []
    for slug, clips in story_map.items():
        result = ale.write_story_files(clips, fps, slug, session["date"], output)
        emit("log", {"message": "ALE: {} ({} clips)".format(result["ale_path"], result["clip_count"])})
        stories.append(result)
    return stories
