/**
 * ALE and FCPXML builders.
 * One ALE/FCPXML per story — all cameras and all cards combined.
 * Camera letter maps to Avid bin colour for visual identification.
 */

// Avid colour per camera letter
const CAM_COLORS = {
  A: 'Cyan',
  B: 'Blue',
  C: 'Green',
  D: 'Magenta',
  E: 'Yellow',
  F: 'Red',
  G: 'Orange',
}

function camColor(cam) {
  return CAM_COLORS[cam?.toUpperCase()] ?? 'White'
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function fpsToFrameDuration(fps) {
  const map = {
    '23.976': '1001/24000s', '24': '100/2400s', '25': '100/2500s',
    '29.97':  '1001/30000s', '30': '100/3000s', '50': '100/5000s',
    '59.94':  '1001/60000s', '60': '100/6000s',
  }
  const key = parseFloat(fps).toFixed(3).replace(/\.000$/, '')
  return map[key] ?? `1/${Math.round(fps)}s`
}

function tcToFrames(tc, fps) {
  const [h, m, s, f] = tc.split(':').map(Number)
  return ((h * 3600 + m * 60 + s) * Math.round(fps)) + f
}

/**
 * Build an ALE for a single story.
 * @param {object[]} clips  - clips with .cam, .name, .tape, .start, .end, .duration, .fps
 * @param {string}   fps    - session frame rate
 * @param {string}   slug   - story slug (for heading comment)
 * @param {string}   date   - MMDD
 */
export function buildALE(clips, fps, slug, date) {
  const COLUMNS = ['Name', 'Tape', 'Start', 'End', 'Duration', 'Tracks', 'FPS', 'Color']

  const lines = [
    'Heading',
    'FIELD_DELIM\tTABS',
    'VIDEO_FORMAT\t1080',
    'AUDIO_FORMAT\t48khz',
    `FPS\t${fps}`,
    '',
    'Column',
    COLUMNS.join('\t'),
    '',
    'Data',
  ]

  for (const clip of clips) {
    lines.push([
      clip.name,
      clip.tape,
      clip.start,
      clip.end,
      clip.duration,
      'VA1A2',
      clip.fps,
      camColor(clip.cam),
    ].join('\t'))
  }

  return lines.join('\n')
}

/**
 * Build FCPXML for a single story — mirrors ALE metadata exactly.
 */
export function buildFCPXML(clips, fps, slug, date, outputRoot) {
  const fRate    = parseFloat(fps)
  const frameDur = fpsToFrameDuration(fps)
  const isoDate  = new Date().toISOString().slice(0, 10)
  const eventName = `${date}_${slug}`

  const assets = clips.map((clip, i) => {
    const durFrames = tcToFrames(clip.duration, fRate)
    const durStr    = `${durFrames}/${Math.round(fRate)}s`
    const src       = xmlEscape(clip.proxyPath ?? clip.filePath)
    return `    <asset id="r${i + 2}" name="${xmlEscape(clip.name)}" start="0s" duration="${durStr}" hasVideo="1" hasAudio="1" audioSources="1" audioChannels="2" audioRate="48000">
      <media-rep kind="original-media" src="file://${src}"/>
      <metadata>
        <md key="com.apple.proapps.studio.reel" value="${xmlEscape(clip.tape)}"/>
        <md key="com.postie.camera"             value="${clip.cam}"/>
        <md key="com.postie.card"               value="${String(clip.cardNum).padStart(3,'0')}"/>
        <md key="com.postie.slug"               value="${slug}"/>
        <md key="com.postie.startTC"            value="${clip.start}"/>
        <md key="com.postie.codec"              value="${xmlEscape(clip.codec ?? '')}"/>
      </metadata>
    </asset>`
  }).join('\n')

  const clipEls = clips.map((clip, i) => {
    const durFrames = tcToFrames(clip.duration, fRate)
    return `        <clip name="${xmlEscape(clip.name)}" ref="r${i + 2}" duration="${durFrames}/${Math.round(fRate)}s" tcFormat="NDF"/>`
  }).join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.11">
  <resources>
    <format id="r1" name="FFVideoFormat1080p${fps}" frameDuration="${frameDur}" width="1920" height="1080"/>
${assets}
  </resources>
  <library location="file://${xmlEscape(outputRoot)}/">
    <event name="${eventName} — ${isoDate}">
      <spine>
${clipEls}
      </spine>
    </event>
  </library>
</fcpxml>`
}
