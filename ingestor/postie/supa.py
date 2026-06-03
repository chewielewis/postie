"""Supabase (PostgREST) client — stdlib urllib, no dependencies.

Source of truth for show / slug / session / card / clip metadata and for the
per-clip checkpoint state machine:

    pending -> copied -> read -> transcoded -> moved

Each clip advances independently, so an interrupted session resumes by
re-querying clips and skipping any already at/past the target stage.
"""

import json
import re
import urllib.request
import urllib.parse
import urllib.error
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .settings import settings

# Ordered checkpoint stages — index gives precedence for "at or past" checks.
STAGES = ["pending", "copied", "read", "transcoded", "moved"]


def stage_index(status: Optional[str]) -> int:
    try:
        return STAGES.index(status or "pending")
    except ValueError:
        return 0


def at_or_past(status: Optional[str], target: str) -> bool:
    return stage_index(status) >= stage_index(target)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Supa:
    def __init__(self) -> None:
        settings.require_supabase()
        self.base = settings.supabase_url.rstrip("/") + "/rest/v1/"
        self.headers = {
            "apikey": settings.supabase_key,
            "Authorization": "Bearer " + settings.supabase_key,
            "Content-Type": "application/json",
            "Prefer": "return=representation",
        }

    # -- low-level -----------------------------------------------------------

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        url = self.base + path
        data = json.dumps(body).encode("utf-8") if body is not None else None
        req = urllib.request.Request(url, data=data, headers=self.headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read().decode("utf-8")
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise RuntimeError("Supabase {} {} failed: {}".format(method, path, detail))

    @staticmethod
    def _qs(filters: Dict[str, str], extra: Optional[Dict[str, str]] = None) -> str:
        params = {k: v for k, v in (extra or {}).items()}
        params.update(filters)
        return urllib.parse.urlencode(params)

    def select(self, table: str, filters: Dict[str, str], extra: Optional[Dict[str, str]] = None) -> List[dict]:
        eq = {k: "eq.{}".format(v) for k, v in filters.items()}
        qs = self._qs(eq, {"select": "*", **(extra or {})})
        return self._request("GET", "{}?{}".format(table, qs)) or []

    def insert(self, table: str, row: dict) -> dict:
        rows = self._request("POST", table, row)
        return rows[0] if isinstance(rows, list) else rows

    def update(self, table: str, match: Dict[str, str], patch: dict) -> Optional[dict]:
        eq = {k: "eq.{}".format(v) for k, v in match.items()}
        rows = self._request("PATCH", "{}?{}".format(table, self._qs(eq)), patch)
        if isinstance(rows, list):
            return rows[0] if rows else None
        return rows

    # -- shows ---------------------------------------------------------------

    def get_show(self, code: str) -> Optional[dict]:
        rows = self.select("shows", {"code": code.upper()})
        return rows[0] if rows else None

    # -- slugs ---------------------------------------------------------------

    def get_slugs(self, show_id: str) -> List[dict]:
        return self.select("slugs", {"show_id": show_id, "active": "true"},
                           {"order": "created_at.asc"})

    def add_slug(self, show_id: str, name: str) -> dict:
        norm = re.sub(r"[^A-Z0-9]", "_", name.upper())
        existing = self.select("slugs", {"show_id": show_id, "name": norm})
        if existing:
            return existing[0]
        return self.insert("slugs", {"show_id": show_id, "name": norm})

    # -- sessions ------------------------------------------------------------

    def get_or_create_session(self, show_id: str, *, date: str, output_path: str,
                              backup_path: Optional[str], avid_path: Optional[str],
                              log_preset: str, fps: str) -> dict:
        existing = self.select("sessions", {
            "show_id": show_id, "date": date, "output_path": output_path,
        })
        if existing:
            return existing[0]
        return self.insert("sessions", {
            "show_id": show_id, "date": date, "output_path": output_path,
            "backup_path": backup_path, "avid_path": avid_path,
            "log_preset": log_preset, "fps": fps,
        })

    def get_session(self, session_id: str) -> Optional[dict]:
        rows = self.select("sessions", {"id": session_id})
        return rows[0] if rows else None

    def get_session_with_cards(self, session_id: str) -> Optional[dict]:
        session = self.get_session(session_id)
        if not session:
            return None
        cards = self.get_cards(session_id)
        for card in cards:
            card["clips"] = self.get_clips(card["id"])
        session["cards"] = cards
        return session

    # -- cards ---------------------------------------------------------------

    def get_cards(self, session_id: str) -> List[dict]:
        return self.select("cards", {"session_id": session_id}, {"order": "created_at.asc"})

    def next_card_num(self, session_id: str, cam: str) -> int:
        cards = self.select("cards", {"session_id": session_id, "cam": cam.upper()})
        return len(cards) + 1

    def add_card(self, session_id: str, *, input_path: str, cam: str, card_num: int) -> dict:
        return self.insert("cards", {
            "session_id": session_id, "input_path": input_path,
            "cam": cam.upper(), "card_num": card_num, "status": "scanned",
        })

    def update_card_status(self, card_id: str, status: str) -> None:
        self.update("cards", {"id": card_id}, {"status": status})

    # -- clips ---------------------------------------------------------------

    def get_clips(self, card_id: str) -> List[dict]:
        return self.select("clips", {"card_id": card_id}, {"order": "created_at.asc"})

    def add_clip(self, card_id: str, clip: dict, slug_id: Optional[str]) -> dict:
        return self.insert("clips", {
            "card_id": card_id,
            "slug_id": slug_id,
            "name": clip["name"],
            "tape": clip["tape"],
            "original_name": clip["original_name"],
            "file_path": clip["file_path"],
            "backup_path": clip.get("backup_path"),
            "preview_path": clip.get("preview_path"),
            "start_tc": clip["start_tc"],
            "end_tc": clip["end_tc"],
            "duration_tc": clip["duration_tc"],
            "duration_sec": clip["duration_sec"],
            "fps": clip["fps"],
            "width": clip["width"],
            "height": clip["height"],
            "codec": clip["codec"],
            "creation_time": clip.get("creation_time"),
            "status": clip.get("status", "pending"),
        })

    def update_clip(self, clip_id: str, patch: dict) -> Optional[dict]:
        return self.update("clips", {"id": clip_id}, patch)

    def set_clip_status(self, clip_id: str, status: str, **extra: Any) -> None:
        patch = {"status": status}
        patch.update({k: v for k, v in extra.items() if v is not None})
        self.update_clip(clip_id, patch)

    def set_relay(self, clip_id: str, group_id: str, part: int) -> None:
        self.update_clip(clip_id, {
            "relay_group": group_id, "relay_part": part, "relay_resolved_at": _now(),
        })

    # -- grouping for ALE ----------------------------------------------------

    def clips_by_slug(self, session_id: str) -> Dict[str, List[dict]]:
        """All clips in a session grouped by slug name, relay parts folded into part 1."""
        session = self.get_session(session_id)
        cards = self.get_cards(session_id)
        slug_rows = self.select("slugs", {"show_id": session["show_id"]}, {"select": "id,name"}) if session else []
        slug_names = {s["id"]: s["name"] for s in slug_rows}

        all_clips: List[dict] = []
        for card in cards:
            for clip in self.get_clips(card["id"]):
                all_clips.append({**clip, "cam": card["cam"], "card_num": card["card_num"]})

        relay_groups: Dict[str, List[dict]] = {}
        for clip in all_clips:
            if clip.get("relay_group"):
                relay_groups.setdefault(clip["relay_group"], []).append(clip)
        for parts in relay_groups.values():
            parts.sort(key=lambda c: c.get("relay_part") or 1)

        out: Dict[str, List[dict]] = {}
        for clip in all_clips:
            if (clip.get("relay_part") or 0) > 1:
                continue  # folded into part 1
            entry = dict(clip)
            if clip.get("relay_group") and clip.get("relay_part") == 1:
                parts = relay_groups.get(clip["relay_group"], [clip])
                entry["relay_combined_duration_sec"] = sum(float(p.get("duration_sec") or 0) for p in parts)
                entry["relay_file_paths"] = [p.get("file_path") for p in parts]
                entry["relay_parts_count"] = len(parts)
            key = slug_names.get(clip.get("slug_id"), "UNASSIGNED") if clip.get("slug_id") else "UNASSIGNED"
            out.setdefault(key, []).append(entry)
        return out
