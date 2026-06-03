"""Configuration and environment loading.

Reads ingestor/.env (KEY=VALUE lines) and falls back to process env.
No external dependencies.
"""

import os
from pathlib import Path
from typing import Dict, Optional

# ingestor/ root — two levels up from this file (postie/settings.py).
PACKAGE_DIR = Path(__file__).resolve().parent
ROOT_DIR = PACKAGE_DIR.parent
LUT_DIR = ROOT_DIR / "luts"


def _parse_env_file(path: Path) -> Dict[str, str]:
    out: Dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        out[key.strip()] = val.strip().strip('"').strip("'")
    return out


_FILE_ENV = _parse_env_file(ROOT_DIR / ".env")


def get(key: str, default: Optional[str] = None) -> Optional[str]:
    """Env var precedence: process env > .env file > default."""
    return os.environ.get(key) or _FILE_ENV.get(key) or default


class Settings:
    def __init__(self) -> None:
        self.supabase_url = get("SUPABASE_URL")
        self.supabase_key = get("SUPABASE_SERVICE_ROLE_KEY")

    def require_supabase(self) -> None:
        if not self.supabase_url or not self.supabase_key:
            raise SystemExit(
                "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n"
                f"Set them in {ROOT_DIR / '.env'} (see .env.example)."
            )


settings = Settings()


# Log-format presets → LUT filename in luts/.
LOG_PRESETS = {
    "slog3": "slog3_to_709.cube",
    "slog2": "slog2_to_709.cube",
    "dlogm": "dlog_m_to_709.cube",
}

# Camera letter → Avid bin colour.
CAM_COLORS = {
    "A": "Cyan",
    "B": "Blue",
    "C": "Green",
    "D": "Magenta",
    "E": "Yellow",
    "F": "Red",
    "G": "Orange",
}

# Container extensions we treat as camera media.
CAMERA_EXTENSIONS = {".mxf", ".mp4", ".mov"}
