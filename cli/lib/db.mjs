/**
 * Season database — Supabase via REST API (Node fetch, no dependencies).
 *
 * To swap to supabase-js later:
 *   1. npm install @supabase/supabase-js in cli/
 *   2. Replace the `query`, `insert`, `update` functions below with:
 *        import { createClient } from '@supabase/supabase-js'
 *        const db = createClient(SUPABASE_URL, SUPABASE_KEY)
 *   3. Update each exported function to use db.from(...) syntax
 *   All callers (ingest.mjs, rushes.mjs) stay unchanged.
 */

import { existsSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

// ---------------------------------------------------------------------------
// Config — load from cli/.env
// ---------------------------------------------------------------------------

function loadEnv() {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), '..', '.env')
  if (!existsSync(envPath)) return {}
  return Object.fromEntries(
    readFileSync(envPath, 'utf8')
      .split('\n')
      .filter(l => l.includes('=') && !l.startsWith('#'))
      .map(l => l.split('=').map(s => s.trim()))
  )
}

const env = loadEnv()
const SUPABASE_URL = env.SUPABASE_URL ?? process.env.SUPABASE_URL
const SUPABASE_KEY = env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in cli/.env')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// REST client
// To swap to supabase-js: replace these three functions only.
// ---------------------------------------------------------------------------

const HEADERS = {
  'apikey':        SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
  'Content-Type':  'application/json',
  'Prefer':        'return=representation',
}

async function query(table, params = {}) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${qs ? '?' + qs : ''}`, { headers: HEADERS })
  if (!res.ok) throw new Error(`Supabase query failed: ${await res.text()}`)
  return res.json()
}

async function insert(table, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Supabase insert failed: ${await res.text()}`)
  const rows = await res.json()
  return Array.isArray(rows) ? rows[0] : rows
}

async function update(table, match, data) {
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(match).map(([k, v]) => [k, `eq.${v}`]))
  ).toString()
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify(data),
  })
  if (!res.ok) throw new Error(`Supabase update failed: ${await res.text()}`)
  const rows = await res.json()
  return Array.isArray(rows) ? rows[0] : rows
}

// ---------------------------------------------------------------------------
// Show
// ---------------------------------------------------------------------------

export async function getShow(code) {
  const rows = await query('shows', { code: `eq.${code.toUpperCase()}`, select: '*' })
  return rows[0] ?? null
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

export async function getSlugs(showId) {
  return query('slugs', { show_id: `eq.${showId}`, active: 'eq.true', select: '*', order: 'created_at.asc' })
}

export async function addSlug(showId, name) {
  const normalised = name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  try {
    return await insert('slugs', { show_id: showId, name: normalised })
  } catch (e) {
    // Already exists — return existing
    const rows = await query('slugs', { show_id: `eq.${showId}`, name: `eq.${normalised}` })
    return rows[0]
  }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export async function getOrCreateSession(showId, { date, outputPath, backupPath, avidPath, logPreset, fps }) {
  const existing = await query('sessions', {
    show_id: `eq.${showId}`, date: `eq.${date}`, output_path: `eq.${outputPath}`, select: '*',
  })
  if (existing.length > 0) return existing[0]

  return insert('sessions', {
    show_id:     showId,
    date,
    output_path: outputPath,
    backup_path: backupPath ?? null,
    avid_path:   avidPath   ?? null,
    log_preset:  logPreset  ?? 'none',
    fps:         fps        ?? '25',
  })
}

export async function getSession(sessionId) {
  const rows = await query('sessions', { id: `eq.${sessionId}`, select: '*' })
  return rows[0] ?? null
}

export async function getSessionWithCards(sessionId) {
  const session = await getSession(sessionId)
  if (!session) return null
  const cards   = await getCards(sessionId)
  for (const card of cards) {
    card.clips = await getClips(card.id)
  }
  session.cards = cards
  return session
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

export async function getCards(sessionId) {
  return query('cards', { session_id: `eq.${sessionId}`, select: '*', order: 'created_at.asc' })
}

export async function nextCardNum(sessionId, cam) {
  const cards = await query('cards', { session_id: `eq.${sessionId}`, cam: `eq.${cam.toUpperCase()}`, select: 'id' })
  return cards.length + 1
}

export async function addCard(sessionId, { inputPath, cam, cardNum }) {
  return insert('cards', {
    session_id: sessionId,
    input_path: inputPath,
    cam:        cam.toUpperCase(),
    card_num:   cardNum,
    status:     'scanned',
  })
}

export async function updateCardStatus(cardId, status) {
  return update('cards', { id: cardId }, { status })
}

// ---------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------

export async function getClips(cardId) {
  return query('clips', { card_id: `eq.${cardId}`, select: '*', order: 'created_at.asc' })
}

export async function addClip(cardId, clip) {
  return insert('clips', {
    card_id:       cardId,
    slug_id:       clip.slugId       ?? null,
    name:          clip.name,
    tape:          clip.tape,
    original_name: clip.originalName,
    file_path:     clip.filePath,
    start_tc:      clip.start,
    end_tc:        clip.end,
    duration_tc:   clip.duration,
    duration_sec:  clip.durationSec,
    fps:           clip.fps,
    width:         clip.width,
    height:        clip.height,
    codec:         clip.codec,
    preview_path:  clip.previewPath  ?? null,
    creation_time: clip.creationTime ?? null,
    status:        'pending',
  })
}

export async function updateClip(clipId, data) {
  return update('clips', { id: clipId }, data)
}

export async function updateClipSlug(clipId, slugId) {
  return update('clips', { id: clipId }, { slug_id: slugId })
}

// ---------------------------------------------------------------------------
// ALE grouping — all clips across all cards for a given slug
// ---------------------------------------------------------------------------

export async function clipsBySlug(sessionId) {
  const session = await getSession(sessionId)
  const cards   = await getCards(sessionId)

  const allSlugs  = session ? await query('slugs', { show_id: `eq.${session.show_id}`, select: 'id,name' }) : []
  const slugNames = Object.fromEntries(allSlugs.map(s => [s.id, s.name]))

  // Collect all clips with card context
  const allClips = []
  for (const card of cards) {
    const clips = await getClips(card.id)
    for (const clip of clips) {
      allClips.push({ ...clip, cam: card.cam, cardNum: card.card_num })
    }
  }

  // Build relay group lookup: groupId → sorted parts
  const relayGroups = {}
  for (const clip of allClips) {
    if (clip.relay_group) {
      ;(relayGroups[clip.relay_group] = relayGroups[clip.relay_group] ?? []).push(clip)
    }
  }
  for (const parts of Object.values(relayGroups)) {
    parts.sort((a, b) => (a.relay_part ?? 1) - (b.relay_part ?? 1))
  }

  const map = {}
  for (const clip of allClips) {
    // Skip relay continuations — part 1 represents the whole take
    if ((clip.relay_part ?? 0) > 1) continue

    let entry = { ...clip }

    // Annotate relay part-1 clips with combined duration + all file paths
    if (clip.relay_group && clip.relay_part === 1) {
      const parts = relayGroups[clip.relay_group] ?? [clip]
      entry.relay_combined_duration_sec = parts.reduce((s, p) => s + (p.duration_sec ?? 0), 0)
      entry.relay_file_paths            = parts.map(p => p.file_path)
      entry.relay_parts_count           = parts.length
    }

    const key = clip.slug_id ? (slugNames[clip.slug_id] ?? clip.slug_id) : 'UNASSIGNED'
    ;(map[key] = map[key] ?? []).push(entry)
  }
  return map
}
