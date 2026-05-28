/**
 * Core ingest operations:
 *   scanCard            — discover files + ffprobe metadata + extract previews
 *   backupCard          — copy originals to backup drive (skips if already there)
 *   transcodeCard       — DNxHR LB to per-session staging folder
 *   transcodeRelayGroup — same for spanned (relay) clips
 *   commitSessionToAvid — move completed staging folder → AvidMediaFiles
 */

import { execSync, spawn }                from 'child_process'
import { existsSync, mkdirSync, readdirSync, statSync,
         copyFileSync, renameSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { basename, extname, join, resolve, dirname } from 'path'
import { fileURLToPath }                  from 'url'
import { tcEnd }                          from './tc.mjs'

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
  const f     = Math.round(fps)
  const total = Math.round(parseFloat(seconds) * f)
  return [
    Math.floor(total / f / 3600),
    Math.floor(total / f / 60) % 60,
    Math.floor(total / f) % 60,
    total % f,
  ].map(n => String(n).padStart(2, '0')).join(':')
}

/**
 * Scan a card: discover files, probe metadata, extract previews.
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
      name:         clipName,
      tape:         clipName,
      originalName,
      filePath:     file,
      slug:         slug ?? null,
      start:        startTC,
      end:          endTC,
      duration:     durTC,
      durationSec,
      fps:          clipFps.toFixed(3),
      width:        vs?.width  ?? 0,
      height:       vs?.height ?? 0,
      codec:        vs?.codec_name?.toUpperCase() ?? 'UNKNOWN',
      previewPath:  null,
      proxyPath:    null,
      backupPath:   null,
      creationTime,
    }

    // Extract preview frame (10% through, capped at 30 s)
    const seekSec    = Math.min(durationSec * 0.1, 30).toFixed(2)
    const previewOut = join(previewDir, `${clipName}.jpg`)
    const vfParts    = []
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

/**
 * Copy src → dest.
 * Returns false (skipped) if dest already exists with the same byte size.
 * Returns true if the file was actually copied.
 */
function copyFile(src, dest) {
  mkdirSync(dirname(dest), { recursive: true })
  if (existsSync(dest) && statSync(dest).size === statSync(src).size) return false
  copyFileSync(src, dest)
  return true
}

export async function backupCard({ card, date, backupRoot }, emit) {
  if (!backupRoot) return
  emit({ type: 'log', data: `Backing up CAM${card.cam} CARD${String(card.cardNum).padStart(3,'0')}…` })

  for (const clip of card.clips) {
    const rel    = basename(clip.filePath)
    const dest   = join(backupRoot, date, `CAM_${card.cam}`, `CARD_${String(card.cardNum).padStart(3,'0')}`, rel)
    const copied = copyFile(clip.filePath, dest)
    emit({ type: 'log', data: copied ? `  → ${rel}` : `  ↷ ${rel} (already on backup — skipped)` })
    clip.backupPath = dest
    emit({ type: 'backup', clip: clip.name })
  }
}

// ---------------------------------------------------------------------------
// Transcode — DNxHR LB proxy
//
// All clips (all cameras, all cards) in a session land in one flat staging dir:
//   <output>/_staging/<date>/
//
// Nothing moves to AvidMediaFiles until commitSessionToAvid() is called at the
// end of the session.  This prevents Avid from indexing partially-written media.
// ---------------------------------------------------------------------------

/**
 * Transcode a relay group (N spanned clips) into one DNxHR LB MXF.
 * parts[] must be sorted by relay_part ascending. Output named after parts[0].
 */
export async function transcodeRelayGroup({ parts, date, output, log, lut, fps = '25', dryRun = false }, emit) {
  const LUT    = resolveLut(log, lut)
  const part1  = parts[0]

  const stagingDir = join(output, '_staging', date)
  mkdirSync(stagingDir, { recursive: true })
  const stagedFile = join(stagingDir, `${part1.name}.mxf`)

  if (!dryRun) {
    if (!existsSync(stagedFile)) {
      emit({ type: 'log',       data: `  [${part1.name}] relay transcode (${parts.length} parts)…` })
      emit({ type: 'transcode', clip: part1.name, status: 'started' })

      const filePaths = parts.map(p => {
        const primary  = p.file_path  ?? p.filePath
        const fallback = p.backup_path ?? p.backupPath
        if (primary  && existsSync(primary))  return primary
        if (fallback && existsSync(fallback)) return fallback
        throw new Error(`File not accessible for relay part ${p.relay_part}: ${primary}`)
      })

      await new Promise((res, rej) => {
        const n         = filePaths.length
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
        ff.on('close', code =>
          code === 0 ? res() : rej(new Error(`FFmpeg relay concat failed:\n${stderr.slice(-400)}`))
        )
      })
    } else {
      emit({ type: 'log', data: `  [${part1.name}] relay already in staging, skipping` })
    }

    if (!existsSync(stagedFile) || statSync(stagedFile).size === 0) {
      throw new Error(`Staged relay file missing or empty: ${stagedFile}`)
    }

    emit({ type: 'transcode', clip: part1.name, status: 'done', proxyPath: stagedFile })
  } else {
    emit({ type: 'transcode', clip: part1.name, status: 'dry-run (relay)' })
  }
}

export async function transcodeCard({ card, date, output, log, lut, fps = '25', dryRun = false }, emit) {
  const LUT = resolveLut(log, lut)

  for (const clip of card.clips) {
    const stagingDir = join(output, '_staging', date)
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

      if (!existsSync(stagedFile) || statSync(stagedFile).size === 0) {
        throw new Error(`Staged file missing or empty: ${stagedFile}`)
      }

      clip.proxyPath = stagedFile
      emit({ type: 'transcode', clip: clip.name, status: 'done', proxyPath: stagedFile })
    } else {
      emit({ type: 'transcode', clip: clip.name, status: 'dry-run' })
    }
  }
}

// ---------------------------------------------------------------------------
// Commit — move the entire session staging folder into AvidMediaFiles
// ---------------------------------------------------------------------------

/**
 * Move <output>/_staging/<date> → <avidRoot>/<sessionFolder> atomically.
 *
 * Uses rename() when on the same volume (fast, instant).
 * Falls back to copy-then-delete when crossing volumes (EXDEV error).
 *
 * Only call this once ALL cards in the session have been transcoded so that
 * Avid never sees a partially-populated folder.
 */
export function commitSessionToAvid({ stagingDir, avidRoot, sessionFolder }, emit) {
  if (!avidRoot) return
  if (!existsSync(stagingDir)) {
    emit({ type: 'log', data: 'No staged files found — skipping Avid commit' })
    return
  }

  const dest = join(avidRoot, sessionFolder)
  mkdirSync(avidRoot, { recursive: true })
  emit({ type: 'log', data: `Moving session folder to Avid: ${dest}` })

  try {
    renameSync(stagingDir, dest)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    // Cross-volume move: copy each file then remove staging dir
    mkdirSync(dest, { recursive: true })
    for (const f of readdirSync(stagingDir)) {
      copyFileSync(join(stagingDir, f), join(dest, f))
    }
    rmSync(stagingDir, { recursive: true, force: true })
  }

  emit({ type: 'log', data: `Avid session folder ready: ${dest}` })
}
