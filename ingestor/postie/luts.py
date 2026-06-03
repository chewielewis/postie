"""LUT resolution shared by thumbnail and transcode stages."""

from pathlib import Path
from typing import Optional

from .settings import LOG_PRESETS, LUT_DIR


def resolve_lut(log_preset: Optional[str], custom: Optional[str] = None) -> Optional[Path]:
    """Return a LUT path for the given log preset, or None for Rec.709/no-op.

    Raises FileNotFoundError if a preset is requested but its .cube is missing.
    """
    if custom:
        p = Path(custom).expanduser().resolve()
        if not p.exists():
            raise FileNotFoundError("LUT file not found: {}".format(p))
        return p
    if not log_preset or log_preset == "none":
        return None
    fname = LOG_PRESETS.get(log_preset)
    if not fname:
        raise ValueError("Unknown log preset: {}".format(log_preset))
    p = LUT_DIR / fname
    if not p.exists():
        raise FileNotFoundError(
            "LUT file not found: {}\nDrop the .cube into {} (see luts/README.md).".format(p, LUT_DIR)
        )
    return p


def lut3d_filter(lut_path: Optional[Path]) -> Optional[str]:
    """ffmpeg lut3d filter string with Windows-safe forward slashes, or None."""
    if not lut_path:
        return None
    return "lut3d='{}'".format(str(lut_path).replace("\\", "/"))
