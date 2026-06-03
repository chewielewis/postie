"""Detect the Avid media drive and Avid project drive among mounted volumes.

Drive letters are not stable between sessions (USB media docks, network mounts),
so paths can't be hardcoded. Instead we fingerprint each volume by its Avid
footprint:

  * media drive   — has ``Avid MediaFiles\\MXF\\`` *containing* ``.mxf`` media.
                    Folder existence alone is not enough: empty ``Avid MediaFiles``
                    shells are left behind on many drives. When several volumes
                    qualify, the one holding the most media wins.
  * project drive — contains an Avid project (a ``.avp`` file), usually alongside
                    an ``Avid Attic`` / ``Unity Attic`` backup folder.

Pure stdlib; Windows-oriented (drive letters) with a POSIX fallback to ``/``.
"""

import string
from pathlib import Path
from typing import List, NamedTuple, Optional


class MediaDrive(NamedTuple):
    root: Path          # e.g. Path('Z:\\')
    mxf_dir: Path       # <root>/Avid MediaFiles/MXF
    clip_count: int
    total_bytes: int


class ProjectDrive(NamedTuple):
    root: Path          # e.g. Path('Y:\\')
    project_file: Optional[Path]   # most-recently-modified .avp found
    project_mtime: float           # its mtime (0.0 if none)
    has_attic: bool


def volumes() -> List[Path]:
    """Mounted filesystem roots. Windows drive letters, else POSIX root."""
    roots = [Path("{}:\\".format(c)) for c in string.ascii_uppercase]
    found = [r for r in roots if r.exists()]
    return found or [Path("/")]


def _media_footprint(root: Path) -> Optional[MediaDrive]:
    """Inspect one volume's Avid MediaFiles\\MXF for real .mxf content."""
    mxf = root / "Avid MediaFiles" / "MXF"
    if not mxf.is_dir():
        return None
    count = 0
    total = 0
    for f in mxf.rglob("*.mxf"):
        try:
            total += f.stat().st_size
            count += 1
        except OSError:
            continue
    if count == 0:
        return None
    return MediaDrive(root, mxf, count, total)


def find_media_drive(roots: Optional[List[Path]] = None) -> Optional[MediaDrive]:
    """The volume actively holding Avid media; the largest one if several."""
    best: Optional[MediaDrive] = None
    for root in (roots or volumes()):
        cand = _media_footprint(root)
        if cand and (best is None or cand.total_bytes > best.total_bytes):
            best = cand
    return best


_AVP_MAX_DEPTH = 2  # active projects are shallow; deep .avp are archives


def _latest_avp(root: Path, max_depth: int = _AVP_MAX_DEPTH):
    """Most-recently-modified .avp within `max_depth` dir levels, or None.

    Bounded depth keeps deep archive copies (e.g. a previous season buried
    several folders down) from masquerading as the active project drive.
    """
    latest = None  # (Path, mtime)

    def walk(d: Path, depth: int) -> None:
        nonlocal latest
        try:
            entries = list(d.iterdir())
        except OSError:
            return
        for entry in entries:
            try:
                if entry.is_file():
                    if entry.suffix.lower() == ".avp":
                        mt = entry.stat().st_mtime
                        if latest is None or mt > latest[1]:
                            latest = (entry, mt)
                elif entry.is_dir() and depth < max_depth:
                    walk(entry, depth + 1)
            except OSError:
                continue

    walk(root, 0)
    return latest


def _has_attic(root: Path) -> bool:
    try:
        return any(d.is_dir() and "attic" in d.name.lower() for d in root.iterdir())
    except OSError:
        return False


def _project_footprint(root: Path) -> Optional[ProjectDrive]:
    """Fingerprint one volume as a possible Avid project drive."""
    attic = _has_attic(root)
    avp = _latest_avp(root)
    if avp is None and not attic:
        return None
    return ProjectDrive(root, avp[0] if avp else None,
                        avp[1] if avp else 0.0, attic)


def find_project_drive(roots: Optional[List[Path]] = None) -> Optional[ProjectDrive]:
    """The volume holding the *active* Avid project.

    Ranked by: has an Attic (live bin backups) > has a shallow .avp > most
    recently modified .avp. The Attic is the strongest signal that this is the
    drive currently being edited from, rather than an archive that merely
    contains old project files.
    """
    def score(c: ProjectDrive):
        return (c.has_attic, c.project_file is not None, c.project_mtime)

    best: Optional[ProjectDrive] = None
    for root in (roots or volumes()):
        cand = _project_footprint(root)
        if cand is None:
            continue
        if best is None or score(cand) > score(best):
            best = cand
    return best


def detect() -> dict:
    """Detect both drives in a single volume sweep. Returns a summary dict."""
    roots = volumes()
    media = find_media_drive(roots)
    project = find_project_drive(roots)
    return {
        "media": media,
        "project": project,
        "avid_path": str(media.mxf_dir) if media else None,
        "project_root": str(project.root) if project else None,
    }


def summary() -> str:
    """One-line human summary for logs / the UI."""
    d = detect()
    m, p = d["media"], d["project"]
    media_s = (
        "media={} ({} clips, {:.0f} GB)".format(
            m.root, m.clip_count, m.total_bytes / (1024 ** 3))
        if m else "media=?"
    )
    proj_s = (
        "project={}{}".format(
            p.root, "" if p.project_file else " (no .avp)")
        if p else "project=?"
    )
    return media_s + "  |  " + proj_s


if __name__ == "__main__":
    import json
    d = detect()
    print(summary())
    print(json.dumps({
        "avid_path": d["avid_path"],
        "project_root": d["project_root"],
    }, indent=2))
