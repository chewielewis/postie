"""Stage 1 — verified copy to the backup drive.

Copies camera originals to the backup drive and verifies integrity with a
BLAKE2b checksum (fast, cryptographic, stdlib). A copy is only reported
successful once the destination hash matches the source. Existing,
hash-matching destinations are skipped so an interrupted session resumes
without re-copying.

Filename uniqueness: the Postie clip name embeds CAM + CARD + original stem,
which disambiguates GoPro/drone footage that reuses names across cards. We
additionally guard against same-card stem collisions via `unique_name`.
"""

import hashlib
import shutil
from pathlib import Path
from typing import Callable, Optional, Set

_CHUNK = 1 << 20  # 1 MiB


def hash_file(path: Path, progress: Optional[Callable[[int], None]] = None) -> str:
    h = hashlib.blake2b(digest_size=16)
    with open(path, "rb") as f:
        while True:
            chunk = f.read(_CHUNK)
            if not chunk:
                break
            h.update(chunk)
            if progress:
                progress(len(chunk))
    return h.hexdigest()


def unique_name(name: str, seen: Set[str]) -> str:
    """Return a name guaranteed not in `seen`, suffixing _2, _3, ... on collision."""
    if name not in seen:
        seen.add(name)
        return name
    i = 2
    while True:
        candidate = "{}_{}".format(name, i)
        if candidate not in seen:
            seen.add(candidate)
            return candidate
        i += 1


def verified_copy(src: Path, dest: Path,
                  emit: Optional[Callable[[str, dict], None]] = None) -> str:
    """Copy src -> dest and verify by checksum. Returns the BLAKE2b hex digest.

    Raises RuntimeError on verification mismatch.
    """
    src = Path(src)
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)

    src_size = src.stat().st_size
    src_hash = hash_file(src)

    # Resume: identical destination already present.
    if dest.exists() and dest.stat().st_size == src_size and hash_file(dest) == src_hash:
        if emit:
            emit("log", {"message": "  {} already backed up (verified)".format(src.name)})
        return src_hash

    tmp = dest.with_suffix(dest.suffix + ".part")
    shutil.copyfile(src, tmp)

    if tmp.stat().st_size != src_size:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("Size mismatch copying {}".format(src.name))

    dest_hash = hash_file(tmp)
    if dest_hash != src_hash:
        tmp.unlink(missing_ok=True)
        raise RuntimeError("Checksum mismatch copying {} (corrupt transfer)".format(src.name))

    tmp.replace(dest)
    if emit:
        emit("log", {"message": "  {} -> backup (verified)".format(src.name)})
    return src_hash
