/**
 * Season database — persisted as JSON at ~/.postie/<show>/db.json
 * Stores slugs (season-wide) and sessions (per day).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join }   from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'

const VERSION = 1

function dbPath(show) {
  return join(homedir(), '.postie', show.toUpperCase(), 'db.json')
}

function empty(show) {
  return { version: VERSION, show: show.toUpperCase(), slugs: [], sessions: [] }
}

export function loadDb(show) {
  const path = dbPath(show)
  if (!existsSync(path)) return empty(show)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return empty(show)
  }
}

export function saveDb(show, db) {
  const path = dbPath(show)
  mkdirSync(join(homedir(), '.postie', show.toUpperCase()), { recursive: true })
  writeFileSync(path, JSON.stringify(db, null, 2), 'utf8')
}

// ---------------------------------------------------------------------------
// Slug operations
// ---------------------------------------------------------------------------

export function getSlugs(db) {
  return db.slugs.filter(s => s.active !== false)
}

export function addSlug(db, name) {
  const normalised = name.toUpperCase().replace(/[^A-Z0-9]/g, '_')
  if (db.slugs.find(s => s.name === normalised)) return normalised
  db.slugs.push({ id: randomUUID(), name: normalised, createdAt: new Date().toISOString(), active: true })
  return normalised
}

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------

export function getOrCreateSession(db, { date, output, backup, avid, log, fps }) {
  let session = db.sessions.find(s => s.date === date && s.output === output)
  if (!session) {
    session = {
      id: randomUUID(),
      date,
      output,
      backup,
      avid,
      log: log ?? 'none',
      fps: fps ?? '25',
      cards: [],
      createdAt: new Date().toISOString(),
    }
    db.sessions.push(session)
  }
  return session
}

export function getSession(db, sessionId) {
  return db.sessions.find(s => s.id === sessionId)
}

// ---------------------------------------------------------------------------
// Card operations
// ---------------------------------------------------------------------------

export function nextCardNum(session, cam) {
  const existing = session.cards.filter(c => c.cam === cam.toUpperCase())
  return existing.length + 1
}

export function addCard(session, { inputPath, cam, clips }) {
  const CAM = cam.toUpperCase()
  const cardNum = nextCardNum(session, CAM)
  const card = {
    id: randomUUID(),
    inputPath,
    cam: CAM,
    cardNum,
    status: 'scanned',
    addedAt: new Date().toISOString(),
    clips: clips.map(c => ({ ...c, status: 'pending' })),
  }
  session.cards.push(card)
  return card
}

export function updateCardStatus(session, cardId, status) {
  const card = session.cards.find(c => c.id === cardId)
  if (card) card.status = status
}

export function updateClipSlug(session, cardId, clipName, slug) {
  const card = session.cards.find(c => c.id === cardId)
  if (!card) return
  const clip = card.clips.find(c => c.name === clipName)
  if (clip) clip.slug = slug
}

// ---------------------------------------------------------------------------
// ALE grouping — all clips across all cards for a given slug
// ---------------------------------------------------------------------------

export function clipsBySlug(session) {
  const map = {}
  for (const card of session.cards) {
    for (const clip of card.clips) {
      const slug = clip.slug ?? 'UNASSIGNED'
      if (!map[slug]) map[slug] = []
      map[slug].push({ ...clip, cam: card.cam, cardNum: card.cardNum })
    }
  }
  return map
}
