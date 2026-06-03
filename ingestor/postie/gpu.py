"""Runtime GPU encoder detection.

DNxHR (the Avid delivery codec) has no hardware encoder — it is always CPU.
GPU acceleration in this pipeline applies to *decode* and to scaling/LUT
filtering on preview/thumbnail generation, plus any future H.264/HEVC
deliverables. We detect the available vendor at runtime rather than
hard-coding, then expose hwaccel flags the transcoder can opt into.
"""

import subprocess
from functools import lru_cache
from typing import List, Optional

# Vendor → (encoder name to look for in `ffmpeg -encoders`, hwaccel decode flag)
_VENDORS = [
    ("nvidia", "h264_nvenc", "cuda"),
    ("intel", "h264_qsv", "qsv"),
    ("amd", "h264_amf", "d3d11va"),
    ("apple", "h264_videotoolbox", "videotoolbox"),
]


@lru_cache(maxsize=1)
def _encoder_list() -> str:
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            capture_output=True, text=True, timeout=15,
        )
        return out.stdout + out.stderr
    except Exception:
        return ""


@lru_cache(maxsize=1)
def detect() -> dict:
    """Return {vendor, hwaccel, available} for the best GPU found, else CPU."""
    encoders = _encoder_list()
    for vendor, enc, hwaccel in _VENDORS:
        if enc in encoders:
            return {"vendor": vendor, "hwaccel": hwaccel, "available": True}
    return {"vendor": "cpu", "hwaccel": None, "available": False}


def hwaccel_decode_flags() -> List[str]:
    """ffmpeg input flags to enable hardware-accelerated decoding, if any."""
    info = detect()
    if info["available"] and info["hwaccel"]:
        return ["-hwaccel", info["hwaccel"]]
    return []


def summary() -> str:
    info = detect()
    if info["available"]:
        return "GPU: {} ({} decode)".format(info["vendor"], info["hwaccel"])
    return "GPU: none — CPU decode/encode"


def deliverable_encoder(codec: str = "h264") -> Optional[str]:
    """Pick a hardware encoder for a deliverable codec (h264/hevc), if present.

    Not used for the DNxHR Avid path (CPU only) but available for future
    proxy/review deliverables.
    """
    info = detect()
    if not info["available"]:
        return None
    enc = "{}_{}".format(codec, {
        "nvidia": "nvenc", "intel": "qsv", "amd": "amf", "apple": "videotoolbox",
    }[info["vendor"]])
    return enc if enc in _encoder_list() else None
