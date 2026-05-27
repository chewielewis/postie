/**
 * Relay (spanned clip) detection.
 *
 * A relay pair is two clips from the same camera where:
 *   1. clipA.end_tc === clipB.start_tc (TC continuity — exclusive end convention)
 *   2. clipB.creation_time ≈ clipA.creation_time + clipA.duration_sec (wall-clock within 15s)
 *
 * Condition 2 is skipped when creation_time is unavailable (not all cameras embed it).
 * This prevents false-positives from Record-Run TC on a new take that happens to be contiguous.
 *
 * Detection is idempotent: safe to re-run after each card commit.
 * It scans ALL clips in the session, so out-of-order card delivery is handled correctly.
 */

import { randomUUID }            from 'crypto'
import { getCards, getClips, updateClip } from './db.mjs'
import { tcToFrames }            from './tc.mjs'

// ---------------------------------------------------------------------------
// Wall-clock check
// ---------------------------------------------------------------------------

function creationTimeGapOk(clipA, clipB) {
  if (!clipA.creation_time || !clipB.creation_time) return true  // no data → allow
  const tA   = new Date(clipA.creation_time).getTime()
  const tB   = new Date(clipB.creation_time).getTime()
  const durMs = (clipA.duration_sec ?? 0) * 1000
  const gap   = Math.abs(tB - (tA + durMs))
  return gap < 15_000
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Run relay detection across all clips in a session.
 * Assigns relay_group (uuid) and relay_part (1-based index) to matched clips.
 * Returns array of chains (each chain is an array of clip rows, sorted by relay_part).
 *
 * @param {string} sessionId
 * @param {string|number} fps  — session frame rate
 */
export async function detectRelays(sessionId, fps) {
  const cards = await getCards(sessionId)

  // Collect all clips with card context
  const allClips = []
  for (const card of cards) {
    const clips = await getClips(card.id)
    for (const clip of clips) {
      allClips.push({ ...clip, cam: card.cam, cardNum: card.card_num })
    }
  }
  if (allClips.length === 0) return []

  // Group by cam for chain detection
  const byCam = {}
  for (const c of allClips) {
    ;(byCam[c.cam] = byCam[c.cam] ?? []).push(c)
  }

  const chains   = []
  const now      = new Date().toISOString()

  for (const clips of Object.values(byCam)) {
    // Build lookup maps
    const startMap = new Map()  // startFrames → clip
    const endMap   = new Map()  // endFrames   → clip

    for (const clip of clips) {
      try {
        startMap.set(tcToFrames(clip.start_tc, fps), clip)
        endMap.set(tcToFrames(clip.end_tc, fps), clip)
      } catch { /* bad TC — skip */ }
    }

    const visited = new Set()

    for (const clip of clips) {
      if (visited.has(clip.id)) continue

      // Only start chains from clips with no predecessor
      let sf
      try { sf = tcToFrames(clip.start_tc, fps) }
      catch { visited.add(clip.id); continue }
      if (endMap.has(sf)) continue  // has predecessor — not a chain start

      // Walk chain forward
      const chain = [clip]
      visited.add(clip.id)
      let cur = clip

      while (true) {
        let ef
        try { ef = tcToFrames(cur.end_tc, fps) }
        catch { break }

        const nxt = startMap.get(ef)
        if (!nxt || visited.has(nxt.id)) break
        if (!creationTimeGapOk(cur, nxt)) break

        chain.push(nxt)
        visited.add(nxt.id)
        cur = nxt
      }

      if (chain.length > 1) chains.push(chain)
    }
  }

  // Assign / update relay groups in DB
  for (const chain of chains) {
    // Preserve an existing group ID if one was already assigned
    const existingId = chain.find(c => c.relay_group)?.relay_group
    const groupId    = existingId ?? randomUUID()

    for (let i = 0; i < chain.length; i++) {
      const c = chain[i]
      if (c.relay_group === groupId && c.relay_part === i + 1) continue  // already correct
      await updateClip(c.id, {
        relay_group:         groupId,
        relay_part:          i + 1,
        relay_resolved_at:   now,
      })
    }
  }

  return chains
}
