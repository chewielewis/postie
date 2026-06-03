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


def _staging_dir(output: str, avid: Optional[str]) -> Path:
    """Where to write the in-progress transcode.

    Stage on the *same volume* as the final Avid dir so finalising is an atomic
    same-volume rename — never a cross-drive copy. The staging folder sits at the
    media drive's root (outside `Avid MediaFiles`) so Avid never indexes a partial
    file. Falls back to the output dir when no Avid path is set.
    """
    if avid:
        anchor = Path(avid).anchor or avid  # e.g. 'Z:\\'
        return Path(anchor) / "_postie_staging"
    return Path(output) / "_staging"


def _staging_file(output: str, avid: Optional[str], name: str) -> Path:
    d = _staging_dir(output, avid)
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
        staged.replace(dest)  # atomic rename — staging is on the same volume
        if emit:
            emit("log", {"message": "  {} -> AvidMediaFiles".format(name)})
        return str(dest)
    return str(staged)


def transcode_clip(clip: dict, *, output: str, avid: Optional[str],
                   log_preset: Optional[str], emit: Emit = None) -> str:
    """Transcode a single clip to DNxHR LB. Returns the final proxy path."""
    staged = _staging_file(output, avid, clip["name"])
    if staged.exists() and staged.stat().st_size > 0:
        if emit:
            emit("log", {"message": "  {} already staged, skipping".format(clip["name"])})
        return _move_to_avid(staged, clip["name"], avid, emit)

    src = _source_path(clip)
    lut = resolve_lut(log_preset)
    if emit:
        emit("log", {"message": "  transcoding {}...".format(clip["name"])})

    # Map the video + EVERY audio track. ffmpeg's default keeps only one audio
    # stream; cameras carry 1/2/4/8 (Sony A-cam = 8 mono mics), all of which must
    # survive into the Avid media. `0:a?` is optional so silent clips don't fail.
    enc = [
        "-map", "0:v:0", "-map", "0:a?",
        "-c:v", "dnxhd", "-profile:v", "dnxhr_lb", "-pix_fmt", "yuv422p",
        "-c:a", "pcm_s16le", "-ar", "48000",
        "-timecode", clip.get("start_tc") or "00:00:00:00",
        "-y", str(staged),
    ]
    vf = lut3d_filter(lut)
    vf_args = ["-vf", vf] if vf else []
    try:
        _run_ffmpeg(gpu.hwaccel_decode_flags() + ["-i", str(src)] + vf_args + enc)
    except RuntimeError:
        # Retry without hwaccel for decoders that choke on it.
        _run_ffmpeg(["-i", str(src)] + vf_args + enc)

    return _move_to_avid(staged, clip["name"], avid, emit)


def transcode_relay_group(parts: List[dict], *, output: str, avid: Optional[str],
                          log_preset: Optional[str], emit: Emit = None) -> str:
    """Concat N relay parts into one DNxHR LB proxy, named after part 1.

    NOTE: the concat filtergraph below carries a single audio track per part.
    Multi-track audio across a relay span is not yet preserved (no relays in the
    current footage); single clips keep all tracks via transcode_clip.
    """
    part1 = parts[0]
    staged = _staging_file(output, avid, part1["name"])
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
