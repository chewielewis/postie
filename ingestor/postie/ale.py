"""Stage 7 — ALE and FCPXML delivery.

ALE drops into Avid and populates subclip metadata (Start/End TC, TapeID,
camera colour). FCPXML mirrors it for a DaVinci Resolve path. One file per
story slug, combining every camera and card.

Relay groups are represented by their part-1 clip, with the combined duration
and end TC of the whole span.
"""

from pathlib import Path
from typing import List

from . import media
from .settings import CAM_COLORS
from .timecode import tc_end, frames_to_tc


def cam_color(cam: str) -> str:
    return CAM_COLORS.get((cam or "").upper(), "White")


def _clip_audio(clip: dict) -> tuple:
    """(track_count, channels) for a clip, from its transcoded proxy (or source)."""
    src = clip.get("proxy_path") or clip.get("file_path")
    return media.audio_layout(Path(src)) if src else (0, 0)


def _tracks_field(track_count: int) -> str:
    """Avid 'Tracks' notation: V plus one A-slot per audio track (VA1A2…)."""
    if track_count <= 0:
        return "V"
    return "V" + "".join("A{}".format(i) for i in range(1, track_count + 1))


def _xml_escape(s) -> str:
    return (str(s).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def _resolved_tc(clip: dict, fps) -> tuple:
    """(start, end, duration) honouring combined relay duration when present."""
    start = clip.get("start_tc")
    end = clip.get("end_tc")
    duration = clip.get("duration_tc")
    combined = clip.get("relay_combined_duration_sec")
    if combined is not None:
        clip_fps = float(clip.get("fps") or fps)
        frames = round(combined * clip_fps)
        end = tc_end(start, frames, clip_fps)
        duration = frames_to_tc(frames, clip_fps)
    return start, end, duration


def build_ale(clips: List[dict], fps, slug: str, date: str) -> str:
    columns = ["Name", "Tape", "Start", "End", "Duration", "Tracks", "FPS",
               "Color", "Slug", "Shoot_Day", "Camera", "Relay_Group"]
    lines = [
        "Heading",
        "FIELD_DELIM\tTABS",
        "VIDEO_FORMAT\t1080",
        "AUDIO_FORMAT\t48khz",
        "FPS\t{}".format(fps),
        "",
        "Column",
        "\t".join(columns),
        "",
        "Data",
    ]
    for clip in clips:
        if (clip.get("relay_part") or 0) > 1:
            continue
        start, end, duration = _resolved_tc(clip, fps)
        tracks, _ = _clip_audio(clip)
        lines.append("\t".join([
            clip["name"],
            clip.get("tape") or clip["name"],
            start, end, duration,
            _tracks_field(tracks),
            str(clip.get("fps") or fps),
            cam_color(clip.get("cam")),
            slug,
            date,
            (clip.get("cam") or "").upper(),
            clip.get("relay_group") or "",
        ]))
    return "\n".join(lines) + "\n"


_FRAME_DUR = {
    "23.976": "1001/24000s", "24": "100/2400s", "25": "100/2500s",
    "29.97": "1001/30000s", "30": "100/3000s", "50": "100/5000s",
    "59.94": "1001/60000s", "60": "100/6000s",
}


def _frame_duration(fps) -> str:
    key = "{:.3f}".format(float(fps)).rstrip("0").rstrip(".")
    return _FRAME_DUR.get(key, "1/{}s".format(round(float(fps))))


def build_fcpxml(clips: List[dict], fps, slug: str, date: str, output_root: str) -> str:
    f_rate = float(fps)
    nf = round(f_rate)
    frame_dur = _frame_duration(fps)
    from datetime import date as _date
    iso = _date.today().isoformat()
    visible = [c for c in clips if (c.get("relay_part") or 0) <= 1]

    assets = []
    clip_els = []
    for i, clip in enumerate(visible):
        dur_sec = clip.get("relay_combined_duration_sec")
        if dur_sec is None:
            dur_sec = float(clip.get("duration_sec") or 0)
        dur_frames = round(dur_sec * f_rate)
        dur_str = "{}/{}s".format(dur_frames, nf)
        src = _xml_escape(clip.get("proxy_path") or clip.get("file_path") or "")
        rid = "r{}".format(i + 2)
        _, a_chans = _clip_audio(clip)
        has_audio = "1" if a_chans > 0 else "0"
        relay_md = ('\n        <md key="com.postie.relayGroup" value="{}"/>'.format(clip["relay_group"])
                    if clip.get("relay_group") else "")
        assets.append(
            '    <asset id="{rid}" name="{name}" start="0s" duration="{dur}" '
            'hasVideo="1" hasAudio="{hasa}" audioSources="1" audioChannels="{achans}" audioRate="48000">\n'
            '      <media-rep kind="original-media" src="file://{src}"/>\n'
            '      <metadata>\n'
            '        <md key="com.apple.proapps.studio.reel" value="{reel}"/>\n'
            '        <md key="com.postie.camera" value="{cam}"/>\n'
            '        <md key="com.postie.slug" value="{slug}"/>\n'
            '        <md key="com.postie.shootDay" value="{date}"/>\n'
            '        <md key="com.postie.startTC" value="{stc}"/>{relay}\n'
            '      </metadata>\n'
            '    </asset>'.format(
                rid=rid, name=_xml_escape(clip["name"]), dur=dur_str, src=src,
                hasa=has_audio, achans=a_chans,
                reel=_xml_escape(clip.get("tape") or clip["name"]),
                cam=(clip.get("cam") or "").upper(), slug=_xml_escape(slug),
                date=date, stc=clip.get("start_tc") or "00:00:00:00", relay=relay_md,
            )
        )
        clip_els.append(
            '        <clip name="{name}" ref="{rid}" duration="{dur}" tcFormat="NDF"/>'.format(
                name=_xml_escape(clip["name"]), rid=rid, dur=dur_str)
        )

    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE fcpxml>\n'
        '<fcpxml version="1.11">\n'
        '  <resources>\n'
        '    <format id="r1" name="FFVideoFormat1080p{fps}" frameDuration="{fd}" width="1920" height="1080"/>\n'
        '{assets}\n'
        '  </resources>\n'
        '  <library location="file://{root}/">\n'
        '    <event name="{date}_{slug} — {iso}">\n'
        '      <spine>\n'
        '{clips}\n'
        '      </spine>\n'
        '    </event>\n'
        '  </library>\n'
        '</fcpxml>\n'.format(
            fps=fps, fd=frame_dur, assets="\n".join(assets),
            root=_xml_escape(output_root), date=date, slug=_xml_escape(slug),
            iso=iso, clips="\n".join(clip_els),
        )
    )


def write_story_files(clips: List[dict], fps, slug: str, date: str, output_root: str) -> dict:
    out = Path(output_root)
    out.mkdir(parents=True, exist_ok=True)
    ale_path = out / "{}_{}.ale".format(date, slug)
    fcpxml_path = out / "{}_{}.fcpxml".format(date, slug)
    ale_path.write_text(build_ale(clips, fps, slug, date), encoding="utf-8")
    fcpxml_path.write_text(build_fcpxml(clips, fps, slug, date, output_root), encoding="utf-8")
    return {"slug": slug, "ale_path": str(ale_path), "fcpxml_path": str(fcpxml_path),
            "clip_count": len([c for c in clips if (c.get("relay_part") or 0) <= 1])}
