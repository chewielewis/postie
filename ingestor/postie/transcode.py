"""Stage 5/6 — transcode to DNxHR LB MXF and organise into AvidMediaFiles.

DNxHR has no hardware encoder (always CPU), but decode and LUT filtering use
the detected GPU when available. Output lands in a per-session `_staging`
folder, is verified non-empty, then moved into AvidMediaFiles only on success
so Avid never indexes a partial file.

Relay groups are concatenated into a single proxy via filter_complex, named
after part 1; continuation parts are skipped by the orchestrator.
"""

import subprocess
from pathlib import Path
from typing import Callable, List, Optional

from . import gpu
from .luts import resolve_lut, lut3d_filter

Emit = Optional[Callable[[str, dict], None]]


def _source_path(clip: dict) -> Path:
    """Prefer the verified backup copy; fall back to the original card path."""
    for key in ("backup_path", "file_path"):
        v = clip.get(key)
        if v and Path(v).exists():
            return Path(v)
    raise FileNotFoundError(
        "No accessible source for {} (card ejected and no backup?)".format(clip.get("name"))
    )


def _staging_file(output: Path, name: str) -> Path:
    d = output / "_staging"
    d.mkdir(parents=True, exist_ok=True)
    return d / "{}.mxf".format(name)


def _run_ffmpeg(args: List[str]) -> None:
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error"] + args,
        capture_output=True, text=True,
    )
    if proc.returncode != 0:
        raise RuntimeError("FFmpeg failed:\n{}".format(proc.stderr[-600:]))


def _move_to_avid(staged: Path, name: str, avid: Optional[str], emit: Emit) -> str:
    if not staged.exists() or staged.stat().st_size == 0:
        raise RuntimeError("Staged file missing or empty: {}".format(staged))
    if avid:
        avid_dir = Path(avid)
        avid_dir.mkdir(parents=True, exist_ok=True)
        dest = avid_dir / "{}.mxf".format(name)
        staged.replace(dest)
        if emit:
            emit("log", {"message": "  {} -> AvidMediaFiles".format(name)})
        return str(dest)
    return str(staged)


def transcode_clip(clip: dict, *, output: str, avid: Optional[str],
                   log_preset: Optional[str], emit: Emit = None) -> str:
    """Transcode a single clip to DNxHR LB. Returns the final proxy path."""
    out_root = Path(output)
    staged = _staging_file(out_root, clip["name"])
    if staged.exists() and staged.stat().st_size > 0:
        if emit:
            emit("log", {"message": "  {} already staged, skipping".format(clip["name"])})
        return _move_to_avid(staged, clip["name"], avid, emit)

    src = _source_path(clip)
    lut = resolve_lut(log_preset)
    if emit:
        emit("log", {"message": "  transcoding {}...".format(clip["name"])})

    args = gpu.hwaccel_decode_flags() + ["-i", str(src)]
    vf = lut3d_filter(lut)
    if vf:
        args += ["-vf", vf]
    args += [
        "-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p",
        "-c:a", "pcm_s16le", "-ar", "48000",
        "-timecode", clip.get("start_tc") or "00:00:00:00",
        "-y", str(staged),
    ]
    try:
        _run_ffmpeg(args)
    except RuntimeError:
        # Retry without hwaccel for decoders that choke on it.
        args2 = ["-i", str(src)]
        if vf:
            args2 += ["-vf", vf]
        args2 += [
            "-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p",
            "-c:a", "pcm_s16le", "-ar", "48000",
            "-timecode", clip.get("start_tc") or "00:00:00:00",
            "-y", str(staged),
        ]
        _run_ffmpeg(args2)

    return _move_to_avid(staged, clip["name"], avid, emit)


def transcode_relay_group(parts: List[dict], *, output: str, avid: Optional[str],
                          log_preset: Optional[str], emit: Emit = None) -> str:
    """Concat N relay parts into one DNxHR LB proxy, named after part 1."""
    part1 = parts[0]
    out_root = Path(output)
    staged = _staging_file(out_root, part1["name"])
    if staged.exists() and staged.stat().st_size > 0:
        if emit:
            emit("log", {"message": "  {} relay already staged".format(part1["name"])})
        return _move_to_avid(staged, part1["name"], avid, emit)

    srcs = [_source_path(p) for p in parts]
    lut = resolve_lut(log_preset)
    n = len(srcs)
    if emit:
        emit("log", {"message": "  relay transcode {} ({} parts)...".format(part1["name"], n)})

    concat_in = "".join("[{0}:v][{0}:a]".format(i) for i in range(n))
    filter_str = "{}concat=n={}:v=1:a=1[v][a]".format(concat_in, n)
    vf = lut3d_filter(lut)
    if vf:
        filter_str = filter_str.replace("[v][a]", "[vc][a];[vc]{}[v]".format(vf))

    args: List[str] = []
    for s in srcs:
        args += ["-i", str(s)]
    args += [
        "-filter_complex", filter_str, "-map", "[v]", "-map", "[a]",
        "-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p",
        "-c:a", "pcm_s16le", "-ar", "48000",
        "-timecode", part1.get("start_tc") or "00:00:00:00",
        "-y", str(staged),
    ]
    _run_ffmpeg(args)
    return _move_to_avid(staged, part1["name"], avid, emit)
