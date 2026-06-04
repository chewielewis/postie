"""Live ingest status from Supabase.

Reads clip status (the engine's source of truth: pending → copied → read →
transcoded → moved) so it monitors any run — UI- or script-launched — and
survives process restarts.

    python -m postie --show PGHI --status          # one snapshot
    python -m postie --show PGHI --status --watch   # refresh live
"""

import os
import sys
import time
from datetime import datetime

from .supa import Supa


def _bar(done: int, total: int, width: int = 24) -> str:
    if total <= 0:
        return "[" + " " * width + "]"
    filled = round(width * done / total)
    return "[" + "#" * filled + "-" * (width - filled) + "]"


def _session_rows(supa: Supa, session: dict):
    cards = supa.get_cards(session["id"])
    rows, total, done = [], 0, 0
    for card in cards:
        clips = supa.get_clips(card["id"])
        n = len(clips)
        moved = sum(1 for c in clips if (c.get("status") or "") == "moved")
        rows.append((card, n, moved))
        total += n
        done += moved
    return rows, total, done


def snapshot(supa: Supa, show: dict, limit: int = 6) -> str:
    sessions = supa.select("sessions", {"show_id": show["id"]},
                           {"order": "created_at.desc"})[:limit]
    if not sessions:
        return "(no sessions yet)"
    lines = []
    for s in sessions:
        rows, total, done = _session_rows(supa, s)
        pct = (100 * done // total) if total else 0
        state = "complete" if total and done == total else "ingesting" if done else "pending"
        lines.append("* {}  {} {}/{} ({}%)  {}".format(
            s.get("date") or "????", _bar(done, total), done, total, pct, state))
        for card, n, moved in rows:
            cstat = "done" if n and moved == n else "{}/{}".format(moved, n)
            lines.append("      CAM {} CARD{:03d}  {:>3} clips  {:>8}".format(
                card.get("cam") or "?", card.get("card_num") or 0, n, cstat))
    return "\n".join(lines)


def run(show_code: str, *, watch: bool = False, interval: float = 4.0) -> None:
    supa = Supa()
    show = supa.get_show(show_code)
    if not show:
        raise SystemExit("Show '{}' not found in Supabase.".format(show_code))

    if not watch:
        print(snapshot(supa, show))
        return

    os.system("")  # enable ANSI escape handling on Windows terminals
    try:
        while True:
            ts = datetime.now().strftime("%H:%M:%S")
            sys.stdout.write("\033[2J\033[H")
            sys.stdout.write("Postie — {} status @ {}  (Ctrl+C to exit)\n\n".format(
                show.get("name") or show_code, ts))
            sys.stdout.write(snapshot(supa, show) + "\n")
            sys.stdout.flush()
            time.sleep(interval)
    except KeyboardInterrupt:
        sys.stdout.write("\n")
