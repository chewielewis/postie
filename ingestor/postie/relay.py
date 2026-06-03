"""Spanned-clip (relay) detection.

Sony FX-series cameras auto-switch media mid-take; the take continues on the
next card/slot as a separate file. A relay pair is two clips from the same
camera where:

  1. clipA.end_tc == clipB.start_tc   (TC continuity, exclusive-end convention)
  2. clipB.creation_time ~= clipA.creation_time + clipA.duration  (wall clock, <15s)

Condition 2 is skipped when creation_time is unavailable, and guards against a
record-run new take that happens to be TC-contiguous.

Detection is idempotent and scans every clip in the session, so cards delivered
out of order still reconcile. Both halves must be on disk (copied) before this
runs — which is why Stage 1 copies all cards first.
"""

import uuid
from datetime import datetime
from typing import List, Optional

from .timecode import tc_to_frames


def _parse_dt(s: Optional[str]) -> Optional[datetime]:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _wall_clock_ok(a: dict, b: dict) -> bool:
    ta, tb = _parse_dt(a.get("creation_time")), _parse_dt(b.get("creation_time"))
    if not ta or not tb:
        return True  # no data → allow
    dur = float(a.get("duration_sec") or 0)
    gap = abs((tb - ta).total_seconds() - dur)
    return gap < 15.0


def detect_relays(supa, session_id: str, fps) -> List[List[dict]]:
    """Find relay chains across the session and persist relay_group/relay_part.

    Returns the list of chains (each a list of clip rows, sorted by part).
    """
    cards = supa.get_cards(session_id)
    all_clips: List[dict] = []
    for card in cards:
        for clip in supa.get_clips(card["id"]):
            all_clips.append({**clip, "cam": card["cam"]})
    if not all_clips:
        return []

    by_cam = {}
    for c in all_clips:
        by_cam.setdefault(c["cam"], []).append(c)

    chains: List[List[dict]] = []
    for clips in by_cam.values():
        start_map = {}
        end_map = {}
        for clip in clips:
            try:
                start_map[tc_to_frames(clip["start_tc"], fps)] = clip
                end_map[tc_to_frames(clip["end_tc"], fps)] = clip
            except ValueError:
                continue

        visited = set()
        for clip in clips:
            if clip["id"] in visited:
                continue
            try:
                sf = tc_to_frames(clip["start_tc"], fps)
            except ValueError:
                visited.add(clip["id"])
                continue
            if sf in end_map:
                continue  # has a predecessor — not a chain start

            chain = [clip]
            visited.add(clip["id"])
            cur = clip
            while True:
                try:
                    ef = tc_to_frames(cur["end_tc"], fps)
                except ValueError:
                    break
                nxt = start_map.get(ef)
                if not nxt or nxt["id"] in visited:
                    break
                if not _wall_clock_ok(cur, nxt):
                    break
                chain.append(nxt)
                visited.add(nxt["id"])
                cur = nxt

            if len(chain) > 1:
                chains.append(chain)

    for chain in chains:
        existing = next((c.get("relay_group") for c in chain if c.get("relay_group")), None)
        group_id = existing or str(uuid.uuid4())
        for i, c in enumerate(chain, start=1):
            if c.get("relay_group") == group_id and c.get("relay_part") == i:
                continue
            supa.set_relay(c["id"], group_id, i)
            c["relay_group"], c["relay_part"] = group_id, i

    return chains
