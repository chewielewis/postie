"""Timecode arithmetic — NDF and SMPTE drop-frame (29.97 / 59.94).

end_tc convention is *exclusive*: the frame immediately after the last
recorded frame. For a continuous span, clipA.end_tc == clipB.start_tc as
frame numbers, which is what the relay detector relies on.
"""

from typing import Union

Num = Union[str, int, float]


def nominal_fps(fps: Num) -> int:
    return round(float(fps))


def is_drop_frame(fps: Num) -> bool:
    f = float(fps)
    return abs(f - 29.97) < 0.01 or abs(f - 59.94) < 0.01


def _drop_per_min(fps: Num) -> int:
    if not is_drop_frame(fps):
        return 0
    return 2 if nominal_fps(fps) == 30 else 4


def _pad(n: int) -> str:
    return str(n).zfill(2)


def tc_to_frames(tc: str, fps: Num) -> int:
    """Timecode string → absolute frame count. Accepts ':' or ';' separators."""
    parts = str(tc).replace(";", ":").split(":")
    if len(parts) != 4:
        raise ValueError("Bad TC: {}".format(tc))
    try:
        h, m, s, f = (int(p) for p in parts)
    except ValueError:
        raise ValueError("Bad TC: {}".format(tc))

    nf = nominal_fps(fps)
    d = _drop_per_min(fps)
    base = h * 3600 * nf + m * 60 * nf + s * nf + f
    if d == 0:
        return base

    total_min = h * 60 + m
    return base - d * (total_min - total_min // 10)


def frames_to_tc(n: int, fps: Num) -> str:
    """Absolute frame count → timecode string. DF output uses ';' separator."""
    nf = nominal_fps(fps)
    d = _drop_per_min(fps)

    if d == 0:
        span = nf * 86400
        n = ((n % span) + span) % span
        f = n % nf
        n //= nf
        s = n % 60
        n //= 60
        m = n % 60
        h = (n // 60) % 24
        return "{}:{}:{}:{}".format(_pad(h), _pad(m), _pad(s), _pad(f))

    fp_min = nf * 60 - d           # frames per drop-minute
    fp_10min = nf * 600 - d * 9    # frames per 10-minute group
    fp_hour = nf * 3600 - d * 54   # frames per hour

    span = fp_hour * 24
    n = ((n % span) + span) % span

    h = n // fp_hour
    n -= h * fp_hour
    m10 = n // fp_10min
    n -= m10 * fp_10min

    if n < nf * 60:
        m1 = 0
        s = n // nf
        f = n % nf
    else:
        n -= nf * 60
        m1 = n // fp_min + 1
        n = n % fp_min + d  # restore skipped frame numbers
        s = n // nf
        f = n % nf

    m = m10 * 10 + m1
    return "{}:{}:{};{}".format(_pad(h), _pad(m % 60), _pad(s), _pad(f))


def tc_end(start_tc: str, frame_count: int, fps: Num) -> str:
    """Exclusive end TC: start + frame_count frames."""
    return frames_to_tc(tc_to_frames(start_tc, fps) + frame_count, fps)


def seconds_to_tc(seconds: Num, fps: Num) -> str:
    nf = nominal_fps(fps)
    return frames_to_tc(round(float(seconds) * nf), fps)


def is_consecutive(end_tc_a: str, start_tc_b: str, fps: Num) -> bool:
    """True if clipB starts exactly where clipA ends (relay-span check)."""
    try:
        return tc_to_frames(end_tc_a, fps) == tc_to_frames(start_tc_b, fps)
    except ValueError:
        return False
