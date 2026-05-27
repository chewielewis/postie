/**
 * Core ingest operations:
 *   scanCard   — discover files + ffprobe metadata + extract previews
 *   ingestCard — backup originals, transcode to staging, verify + move to AvidMediaFiles
 */

import { execSync, spawn }                                    from 'child_process'
import { existsSync, mkdirSync, readdirSync, statSync,
         copyFileSync, renameSync, writeFileSync, readFileSync } from 'fs'
import { basename, extname, join, resolve, dirname }         from 'path'
import { fileURLToPath }                                      from 'url'
import { tcEnd }                                             from './tc.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

const LOG_PRESETS = {
  slog2: 'slog2_to_709.cube',
  slog3: 'slog3_to_709.cube',
  dlogm: 'dlog_m_to_709.cube',
}

export function resolveLut(logPreset, customLut) {
  if (customLut) {
    const p = resolve(customLut)
    if (!existsSync(p)) throw new Error(`LUT file not found: ${p}`)
    return p
  }
  if (!logPreset || logPreset === 'none') return null
  const file = LOG_PRESETS[logPreset]
  if (!file) throw new Error(`Unknown log preset: ${logPreset}`)
  const p = join(SCRIPT_DIR, '..', 'luts', file)
  if (!existsSync(p)) throw new Error(`LUT file not found: ${p}\nSee cli/luts/README.md`)
  return p
}

const CAMERA_EXTENSIONS = new Set(['.mxf', '.MXF', '.mp4', '.MP4', '.mov', '.MOV'])

// Read creation time from Sony NRT XML sidecar (next to the MXF on the card).
// Returns ISO string or null.
function sonyCreationTime(filePath) {
  const base = basename(filePath, extname(filePath))
  const dir  = dirname(filePath)
  const candidates = [
    join(dir, `${base}M01.XML`), join(dir, `${base}C01.XML`),
    join(dir, `${base}.XML`),    join(dir, '..', 'Sub', `${base}M01.XML`),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const xml = readFileSync(p, 'utf8')
      const m   = xml.match(/<CreationDate[^>]+value="([^"]+)"/)
      if (m) return new Date(m[1]).toISOString()
    } catch {}
  }
  return null
}

export function scanDir(dir) {
  const results = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) results.push(...scanDir(full))
    else if (entry.isFile() && CAMERA_EXTENSIONS.has(extname(entry.name))) results.push(full)
  }
  return results
}

export function probe(filePath) {
  try {
    const raw = execSync(
      `ffprobe -v quiet -print_format json -show_streams -show_format "${filePath}"`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    ).toString()
    return JSON.parse(raw)
  } catch { return null }
}

function toTimecode(seconds, fps) {
  const f      = Math.round(fps)
  const total  = Math.round(parseFloat(seconds) * f)
  return [
    Math.floor(total / f / 3600),
    Math.floor(total / f / 60) % 60,
    Math.floor(total / f) % 60,
    total % f,
  ].map(n => String(n).padStart(2, '0')).join(':')
}

/**
 * Scan a card: discover files, probe metadata, extract previews.
 * Returns an array of clip objects (no slug assigned yet).
 */
export async function scanCard({ inputPath, cam, cardNum, date, slug, output, log, lut, fps = '25' }, emit) {
  const CAM     = cam.toUpperCase()
  const CARDSTR = String(cardNum).padStart(3, '0')
  const LUT     = resolveLut(log, lut)

  const previewDir = join(output, date, '_previews', `CAM${CAM}_CARD${CARDSTR}`)
  mkdirSync(previewDir, { recursive: true })

  emit({ type: 'log', data: `Scanning ${inputPath}…` })
  const files = scanDir(inputPath)
  emit({ type: 'log', data: `Found ${files.length} file(s)` })

  const clips = []

  for (const file of files) {
    emit({ type: 'log', data: `  Probing ${basename(file)}…` })
    const info = probe(file)
    if (!info) { emit({ type: 'log', data: `  Skipped (probe failed)` }); continue }

    const vs  = info.streams?.find(s => s.codec_type === 'video')
    const fmt = info.format

    const durationSec  = parseFloat(fmt?.duration ?? 0)
    const [num, den]   = (vs?.r_frame_rate ?? `${fps}/1`).split('/').map(Number)
    const clipFps      = den ? num / den : parseFloat(fps)
    const totalFrames  = Math.round(durationSec * clipFps)

    const startTC      = vs?.tags?.timecode ?? fmt?.tags?.timecode ?? toTimecode(0, clipFps)
    const endTC        = tcEnd(startTC, totalFrames, String(clipFps))
    const durTC        = toTimecode(durationSec, clipFps)
    const creationTime = fmt?.tags?.creation_time ?? sonyCreationTime(file) ?? null

    const originalName = basename(file, extname(file)).replace(/[^A-Za-z0-9_-]/g, '_').toUpperCase()
    const SLUG_PART    = slug ? slug.toUpperCase().replace(/[^A-Z0-9]/g, '_') : 'UNASSIGNED'
    const clipName     = `${date}_${SLUG_PART}_CAM${CAM}_CARD${CARDSTR}_${originalName}`

    const clip = {
      name:        clipName,
      tape:        clipName,
      originalName,
      filePath:    file,
      slug:        slug ?? null,
      start:       startTC,
      end:         endTC,
      duration:    durTC,
      durationSec,
      fps:         clipFps.toFixed(3),
      width:       vs?.width  ?? 0,
      height:      vs?.height ?? 0,
      codec:       vs?.codec_name?.toUpperCase() ?? 'UNKNOWN',
      previewPath:  null,
      proxyPath:    null,
      backupPath:   null,
      creationTime,
    }

    // Extract preview frame (10% through, capped at 30s)
    const seekSec   = Math.min(durationSec * 0.1, 30).toFixed(2)
    const previewOut = join(previewDir, `${clipName}.jpg`)
    const vfParts   = []
    if (LUT) vfParts.push(`lut3d=${LUT.replace(/\\/g, '/')}`)
    vfParts.push('scale=640:-1')

    try {
      execSync([
        'ffmpeg', '-ss', seekSec,
        '-i', `"${file}"`,
        '-vf', `"${vfParts.join(',')}"`,
        '-frames:v', '1', '-q:v', '3', '-y', `"${previewOut}"`,
      ].join(' '), { stdio: ['ignore', 'ignore', 'pipe'] })
      clip.previewPath = previewOut
    } catch { /* preview failure is non-fatal */ }

    clips.push(clip)
    emit({ type: 'preview', clip })
  }

  return clips
}

// ---------------------------------------------------------------------------
// Backup — copy originals to backup drive
// ---------------------------------------------------------------------------

function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  copyFileSync(src, dest)
}

export async function backupCard({ card, date, backupRoot }, emit) {
  if (!backupRoot) return
  emit({ type: 'log', data: `Backing up CAM${card.cam} CARD${String(card.cardNum).padStart(3,'0')}…` })

  for (const clip of card.clips) {
    const rel  = basename(clip.filePath)
    const dest = join(backupRoot, date, `CAM_${card.cam}`, `CARD_${String(card.cardNum).padStart(3,'0')}`, rel)
    emit({ type: 'log', data: `  → ${rel}` })
    copyFile(clip.filePath, dest)
    clip.backupPath = dest
    emit({ type: 'backup', clip: clip.name })
  }
}

// ---------------------------------------------------------------------------
// Transcode — DNxHR LB to staging folder, then move to AvidMediaFiles
// ---------------------------------------------------------------------------

/**
 * Transcode a relay group (N spanned clips) into one DNxHR LB MXF via filter_complex concat.
 * parts[] must be sorted by relay_part ascending. Output is named after parts[0].
 */
export async function transcodeRelayGroup({ parts, date, output, avid, log, lut, fps = '25', dryRun = false }, emit) {
  const LUT      = resolveLut(log, lut)
  const part1    = parts[0]
  const SLUG_PART = (part1.slug ?? 'UNASSIGNED').toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const CARDSTR   = String(part1.cardNum ?? part1.card_num ?? 1).padStart(3, '0')

  const stagingDir = join(output, '_staging', `${date}_${SLUG_PART}_CAM${part1.cam}_CARD${CARDSTR}`)
  mkdirSync(stagingDir, { recursive: true })

  const stagedFile = join(stagingDir, `${part1.name}.mxf`)

  if (!dryRun) {
    if (!existsSync(stagedFile)) {
      emit({ type: 'log', data: `  [${part1.name}] relay transcode (${parts.length} parts)…` })
      emit({ type: 'transcode', clip: part1.name, status: 'started' })

      // Resolve file paths — prefer backup_path if original is offline
      const filePaths = parts.map(p => {
        const primary  = p.file_path  ?? p.filePath
        const fallback = p.backup_path ?? p.backupPath
        if (primary && existsSync(primary))  return primary
        if (fallback && existsSync(fallback)) return fallback
        throw new Error(`File not accessible for relay part ${p.relay_part}: ${primary}`)
      })

      await new Promise((res, rej) => {
        // Build -filter_complex concat for N video + 2 audio streams
        const n = filePaths.length
        const filterIn  = filePaths.map((_, i) => `[${i}:v][${i}:a]`).join('')
        const filterStr = `${filterIn}concat=n=${n}:v=1:a=1[v][a]`
        const inputs    = filePaths.flatMap(f => ['-i', f])
        const vf        = LUT
          ? ['-filter_complex', `${filterStr},lut3d=${LUT.replace(/\\/g, '/')}`, '-map', '[v]', '-map', '[a]']
          : ['-filter_complex', filterStr, '-map', '[v]', '-map', '[a]']

        const ff = spawn('ffmpeg', [
          ...inputs, ...vf,
          '-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p',
          '-c:a', 'pcm_s16le',
          '-timecode', part1.start_tc ?? part1.start,
          '-y', stagedFile,
        ], { stdio: ['ignore', 'ignore', 'pipe'] })

        let stderr = ''
        ff.stderr.on('data', d => { stderr += d.toString() })
        ff.on('close', code => code === 0 ? res() : rej(new Error(`FFmpeg relay concat failed:\n${stderr.slice(-400)}`)))
      })
    } else {
      emit({ type: 'log', data: `  [${part1.name}] relay already in staging, skipping` })
    }

    if (!existsSync(stagedFile) || statSync(stagedFile).size === 0) {
      throw new Error(`Staged relay file missing or empty: ${stagedFile}`)
    }

    if (avid) {
      mkdirSync(avid, { recursive: true })
      const avidDest = join(avid, `${part1.name}.mxf`)
      renameSync(stagedFile, avidDest)
      emit({ type: 'log',       data: `  [${part1.name}] relay proxy moved to AvidMediaFiles` })
      emit({ type: 'transcode', clip: part1.name, status: 'done', proxyPath: avidDest })
    } else {
      emit({ type: 'transcode', clip: part1.name, status: 'done', proxyPath: stagedFile })
    }
  } else {
    emit({ type: 'transcode', clip: part1.name, status: 'dry-run (relay)' })
  }
}

export async function transcodeCard({ card, date, output, avid, log, lut, fps = '25', dryRun = false }, emit) {
  const LUT = resolveLut(log, lut)

  for (const clip of card.clips) {
    const SLUG_PART = (clip.slug ?? 'UNASSIGNED').toUpperCase().replace(/[^A-Z0-9]/g, '_')
    const CARDSTR   = String(card.cardNum).padStart(3, '0')

    // Staging path — transcode here first
    const stagingDir = join(output, '_staging', `${date}_${SLUG_PART}_CAM${card.cam}_CARD${CARDSTR}`)
    mkdirSync(stagingDir, { recursive: true })

    const stagedFile = join(stagingDir, `${clip.name}.mxf`)

    if (!dryRun) {
      if (!existsSync(stagedFile)) {
        emit({ type: 'log',       data: `  [${clip.name}] transcoding…` })
        emit({ type: 'transcode', clip: clip.name, status: 'started' })

        await new Promise((res, rej) => {
          const vf = LUT ? ['-vf', `lut3d=${LUT.replace(/\\/g, '/')}`] : []
          const ff = spawn('ffmpeg', [
            '-i', clip.filePath, ...vf,
            '-c:v', 'dnxhd', '-profile:v', 'dnxhr_lb', '-pix_fmt', 'yuv422p',
            '-c:a', 'pcm_s16le', '-y', stagedFile,
          ], { stdio: ['ignore', 'ignore', 'pipe'] })
          let stderr = ''
          ff.stderr.on('data', d => { stderr += d.toString() })
          ff.on('close', code => {
            if (code === 0) res()
            else rej(new Error(`FFmpeg failed:\n${stderr.slice(-400)}`))
          })
        })
      } else {
        emit({ type: 'log', data: `  [${clip.name}] already in staging, skipping` })
      }

      // Verify: staged file must exist and be non-zero
      if (!existsSync(stagedFile) || statSync(stagedFile).size === 0) {
        throw new Error(`Staged file missing or empty: ${stagedFile}`)
      }

      // Move to AvidMediaFiles
      if (avid) {
        mkdirSync(avid, { recursive: true })
        const avidDest = join(avid, `${clip.name}.mxf`)
        renameSync(stagedFile, avidDest)
        clip.proxyPath = avidDest
        emit({ type: 'log',       data: `  [${clip.name}] moved to AvidMediaFiles` })
        emit({ type: 'transcode', clip: clip.name, status: 'done', proxyPath: avidDest })
      } else {
        clip.proxyPath = stagedFile
        emit({ type: 'transcode', clip: clip.name, status: 'done', proxyPath: stagedFile })
      }
    } else {
      emit({ type: 'transcode', clip: clip.name, status: 'dry-run' })
    }
  }
}
