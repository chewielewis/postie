/**
 * Timecode arithmetic — NDF and SMPTE drop-frame (29.97, 59.94).
 * All functions accept fps as a string or number.
 *
 * end_tc convention: exclusive (one frame past last frame) — matches Avid ALE.
 * So for a continuous span: clipA.end_tc === clipB.start_tc as frame numbers.
 */

function nominalFps(fps) {
  return Math.round(parseFloat(fps))
}

export function isDropFrame(fps) {
  const f = parseFloat(fps)
  return Math.abs(f - 29.97) < 0.01 || Math.abs(f - 59.94) < 0.01
}

function dropPerMin(fps) {
  const n = nominalFps(fps)
  if (!isDropFrame(fps)) return 0
  return n === 30 ? 2 : 4
}

/**
 * TC string → absolute frame count.
 * Accepts ':' or ';' as frame separator.
 */
export function tcToFrames(tc, fps) {
  const parts = String(tc).replace(';', ':').split(':').map(Number)
  if (parts.length !== 4 || parts.some(isNaN)) throw new Error(`Bad TC: ${tc}`)
  const [H, M, S, F] = parts
  const nf = nominalFps(fps)
  const D  = dropPerMin(fps)

  const base = H * 3600 * nf + M * 60 * nf + S * nf + F
  if (D === 0) return base

  // SMPTE drop-frame: subtract skipped frame numbers
  const totalMin = H * 60 + M
  return base - D * (totalMin - Math.floor(totalMin / 10))
}

/**
 * Absolute frame count → TC string.
 * DF output uses ';' as frame separator per convention.
 */
export function framesToTc(n, fps) {
  const nf = nominalFps(fps)
  const D  = dropPerMin(fps)

  if (D === 0) {
    n = ((n % (nf * 86400)) + nf * 86400) % (nf * 86400)
    const F = n % nf;  n = Math.floor(n / nf)
    const S = n % 60;  n = Math.floor(n / 60)
    const M = n % 60;  const H = Math.floor(n / 60) % 24
    return `${p(H)}:${p(M)}:${p(S)}:${p(F)}`
  }

  // SMPTE DF inverse
  const fpM   = nf * 60 - D          // frames per drop-minute (1798 / 3596)
  const fp10M = nf * 600 - D * 9     // frames per 10-min group
  const fpH   = nf * 3600 - D * 54   // frames per hour

  n = ((n % (fpH * 24)) + fpH * 24) % (fpH * 24)

  const H   = Math.floor(n / fpH);  n -= H * fpH
  const m10 = Math.floor(n / fp10M); n -= m10 * fp10M

  let m1, S, F
  if (n < nf * 60) {
    m1 = 0
    S  = Math.floor(n / nf)
    F  = n % nf
  } else {
    n -= nf * 60
    m1 = Math.floor(n / fpM) + 1
    n  = n % fpM + D       // restore skipped frame numbers
    S  = Math.floor(n / nf)
    F  = n % nf
  }

  const M   = m10 * 10 + m1
  const sep = ';'
  return `${p(H)}:${p(M % 60)}:${p(S)}${sep}${p(F)}`
}

function p(n) { return String(n).padStart(2, '0') }

/**
 * Exclusive end TC: the frame immediately after the last recorded frame.
 * start_tc + frameCount frames.
 */
export function tcEnd(startTc, frameCount, fps) {
  return framesToTc(tcToFrames(startTc, fps) + frameCount, fps)
}

/**
 * True if clipB starts exactly where clipA ends (relay-span check).
 * Uses exclusive end convention: clipA.end_tc frame# === clipB.start_tc frame#.
 */
export function tcIsConsecutive(endTcA, startTcB, fps) {
  try {
    return tcToFrames(endTcA, fps) === tcToFrames(startTcB, fps)
  } catch {
    return false
  }
}
