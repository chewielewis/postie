"""Stage 2/3 — media discovery, ffprobe metadata, thumbnail extraction.

Reads camera files (Sony XAVC MXF, GoPro/DJI/A7S MP4/MOV), derives the Postie
naming convention, and renders a LUT-corrected preview frame for operator
confirmation.

Naming convention:  MMDD_SLUG_CAM<X>_CARD<NNN>_<OriginalName>
"""

import json
import re
import subprocess
from pathlib import Path
from typing import List, Optional

from . import gpu
from .luts import resolve_lut, lut3d_filter
from .settings import CAMERA_EXTENSIONS
from .timecode import tc_end, frames_to_tc, seconds_to_tc


def scan_dir(root: Path) -> List[Path]:
    """Recursively collect camera media files under root."""
    found: List[Path] = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix.lower() in CAMERA_EXTENSIONS:
            found.append(p)
    return found


def probe(path: Path) -> Optional[dict]:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_streams", "-show_format", str(path)],
            capture_output=True, text=True, timeout=60,
        )
        if out.returncode != 0:
            return None
        return json.loads(out.stdout)
    except Exception:
        return None


def audio_layout(path: Path) -> tuple:
    """(audio_track_count, total_channels) for a media file, via ffprobe."""
    info = probe(path)
    if not info:
        return (0, 0)
    streams = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    channels = sum(int(s.get("channels") or 0) for s in streams)
    return (len(streams), channels)


# Little-endian PCM flavours that drop straight into MXF with a stream copy.
_LE_PCM = {"pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_u8", "pcm_f32le", "pcm_f64le"}


def audio_codec_args(path: Path) -> List[str]:
    """ffmpeg `-c:a` args that move audio into MXF without quality loss.

    Audio is never re-sampled or bit-depth-reduced:
      * little-endian PCM (e.g. Sony A-cam pcm_s24le) → stream copy, bit-exact;
      * big-endian PCM (MP4 cams, pcm_sNNbe) → byte-swap to pcm_sNNle (MXF can't
        hold big-endian PCM) — same samples, same bit depth;
      * anything non-PCM → pcm_s24le as a high-quality last resort.
    """
    info = probe(path)
    streams = [s for s in (info or {}).get("streams", []) if s.get("codec_type") == "audio"]
    if not streams:
        return ["-c:a", "copy"]
    codec = (streams[0].get("codec_name") or "").lower()
    if codec in _LE_PCM:
        return ["-c:a", "copy"]
    m = re.match(r"pcm_s(\d+)be$", codec)
    if m:
        return ["-c:a", "pcm_s{}le".format(m.group(1))]
    return ["-c:a", "pcm_s24le"]


def sony_creation_time(path: Path) -> Optional[str]:
    """Read CreationDate from a Sony NRT XML sidecar, if present."""
    base = path.stem
    candidates = [
        path.with_name(base + "M01.XML"),
        path.with_name(base + "C01.XML"),
        path.with_name(base + ".XML"),
        path.parent.parent / "Sub" / (base + "M01.XML"),
    ]
    for c in candidates:
        if not c.exists():
            continue
        try:
            xml = c.read_text(encoding="utf-8", errors="replace")
            m = re.search(r'<CreationDate[^>]+value="([^"]+)"', xml)
            if m:
                return m.group(1)
        except Exception:
            pass
    return None


def _sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "_", name).upper()


def slug_part(slug: Optional[str]) -> str:
    return re.sub(r"[^A-Z0-9]", "_", slug.upper()) if slug else "UNASSIGNED"


def build_clip(path: Path, *, cam: str, card_num: int, date: str,
               slug: Optional[str], fps_default: str) -> dict:
    """Probe a file and build a clip metadata dict (no slug_id yet)."""
    info = probe(path)
    if not info:
        raise RuntimeError("ffprobe failed for {}".format(path.name))

    streams = info.get("streams", [])
    vs = next((s for s in streams if s.get("codec_type") == "video"), {})
    fmt = info.get("format", {})

    duration_sec = float(fmt.get("duration") or 0)
    rate = vs.get("r_frame_rate") or "{}/1".format(fps_default)
    num, _, den = rate.partition("/")
    try:
        clip_fps = float(num) / float(den) if den and float(den) else float(fps_default)
    except (ValueError, ZeroDivisionError):
        clip_fps = float(fps_default)
    total_frames = round(duration_sec * clip_fps)

    start_tc = (vs.get("tags", {}).get("timecode")
                or fmt.get("tags", {}).get("timecode")
                or "00:00:00:00")
    end_tc = tc_end(start_tc, total_frames, clip_fps)
    duration_tc = seconds_to_tc(duration_sec, clip_fps)
    creation_time = fmt.get("tags", {}).get("creation_time") or sony_creation_time(path)

    original = _sanitize(path.stem)
    cam = cam.upper()
    cardstr = str(card_num).zfill(3)
    clip_name = "{}_{}_CAM{}_CARD{}_{}".format(date, slug_part(slug), cam, cardstr, original)

    return {
        "name": clip_name,
        "tape": clip_name,
        "original_name": original,
        "file_path": str(path),
        "slug": slug,
        "start_tc": start_tc,
        "end_tc": end_tc,
        "duration_tc": duration_tc,
        "duration_sec": round(duration_sec, 3),
        "fps": "{:.3f}".format(clip_fps),
        "width": vs.get("width") or 0,
        "height": vs.get("height") or 0,
        "codec": (vs.get("codec_name") or "unknown").upper(),
        "creation_time": creation_time,
        "preview_path": None,
        "backup_path": None,
        "status": "pending",
    }


def extract_thumbnail(src: Path, out: Path, *, log_preset: Optional[str],
                      duration_sec: float = 0.0) -> Optional[Path]:
    """Render a single LUT-corrected preview frame ~10% into the clip."""
    out.parent.mkdir(parents=True, exist_ok=True)
    lut = resolve_lut(log_preset)
    seek = min(duration_sec * 0.1, 30.0) if duration_sec else 1.0

    vf_parts = []
    f = lut3d_filter(lut)
    if f:
        vf_parts.append(f)
    vf_parts.append("scale=640:-2")

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error"]
    cmd += gpu.hwaccel_decode_flags()
    cmd += ["-ss", "{:.2f}".format(seek), "-i", str(src),
            "-vf", ",".join(vf_parts), "-frames:v", "1", "-q:v", "3",
            "-y", str(out)]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and out.exists():
            return out
    except Exception:
        pass
    # Retry without hwaccel (some decoders reject -ss before -hwaccel input)
    try:
        cmd2 = ["ffmpeg", "-hide_banner", "-loglevel", "error",
                "-ss", "{:.2f}".format(seek), "-i", str(src),
                "-vf", ",".join(vf_parts), "-frames:v", "1", "-q:v", "3",
                "-y", str(out)]
        r = subprocess.run(cmd2, capture_output=True, text=True, timeout=120)
        if r.returncode == 0 and out.exists():
            return out
    except Exception:
        pass
    return None
