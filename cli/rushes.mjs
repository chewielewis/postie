#!/usr/bin/env node
/**
 * postie-rushes  —  PGHI ingest tool
 *
 * Usage:  node rushes.mjs --ui [--show PGHI] [--port 4321]
 *         node rushes.mjs --help
 *
 * Requirements: Node.js 18+, ffmpeg (brew install ffmpeg)
 */

import { createServer }                          from 'http'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { basename }                              from 'path'
import { parseArgs }                             from 'util'
import { randomUUID }                            from 'crypto'

import { loadDb, saveDb, getSlugs, addSlug,
         getOrCreateSession, getSession,
         addCard, updateCardStatus, updateClipSlug,
         clipsBySlug }                           from './lib/db.mjs'
import { buildALE, buildFCPXML }                 from './lib/formats.mjs'
import { scanCard, backupCard, transcodeCard }   from './lib/ingest.mjs'
import { join, resolve }                         from 'path'
import { mkdirSync }                             from 'fs'

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    ui:    { type: 'boolean', default: true },
    show:  { type: 'string',  default: 'PGHI' },
    port:  { type: 'string',  default: '4321' },
    help:  { type: 'boolean', default: false },
  },
  strict: false,
})

if (args.help) {
  console.log('Usage: node rushes.mjs [--show PGHI] [--port 4321]\nOpen http://localhost:<port> in a browser.')
  process.exit(0)
}

const SHOW = args.show.toUpperCase()
const PORT = parseInt(args.port)

// ---------------------------------------------------------------------------
// In-memory job state (SSE clients + scan results awaiting confirmation)
// ---------------------------------------------------------------------------

const jobs    = new Map()  // jobId → { events[], clients[] }
const scans   = new Map()  // scanId → { clips[], card metadata }

function createJob() {
  const id = randomUUID()
  jobs.set(id, { events: [], clients: [] })
  return id
}

function emitToJob(jobId, type, data) {
  const job = jobs.get(jobId)
  if (!job) return
  const payload = { type, data, ts: Date.now() }
  job.events.push(payload)
  const line = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`
  job.clients.forEach(c => { try { c.write(line) } catch {} })
}

// ---------------------------------------------------------------------------
// HTML UI
// ---------------------------------------------------------------------------

const HTML = /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Postie Rushes — ${SHOW}</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
:root {
  --bg:#0a0a0a; --s1:#111; --s2:#181818; --s3:#222;
  --b:#2a2a2a; --t:#e8e8e8; --m:#777; --m2:#555;
  --accent:#E63946; --green:#4ade80; --blue:#60a5fa;
}
body { background:var(--bg); color:var(--t); font-family:system-ui,sans-serif; font-size:14px }
a { color:inherit; text-decoration:none }

/* Layout */
.app { display:grid; grid-template-columns:280px 1fr; min-height:100vh }
.sidebar { background:var(--s1); border-right:1px solid var(--b); padding:24px 20px; display:flex; flex-direction:column; gap:24px }
.main { padding:32px 28px; overflow-y:auto }

/* Sidebar */
.logo { font-size:13px; font-weight:700; letter-spacing:.1em; color:var(--accent) }
.show-badge { display:inline-block; font-size:10px; font-weight:600; padding:2px 7px; border-radius:4px; background:var(--accent)22; color:var(--accent); margin-top:4px }
.sidebar-section { display:flex; flex-direction:column; gap:8px }
.sidebar-label { font-size:10px; text-transform:uppercase; letter-spacing:.08em; color:var(--m2); margin-bottom:2px }
.slug-list { display:flex; flex-direction:column; gap:4px }
.slug-item {
  display:flex; align-items:center; justify-content:space-between;
  font-size:12px; padding:6px 10px; border-radius:6px;
  background:var(--s2); border:1px solid var(--b); cursor:pointer; transition:border-color .15s;
}
.slug-item:hover { border-color:#444 }
.slug-item.selected { border-color:var(--accent); background:var(--accent)11 }
.slug-dot { width:6px; height:6px; border-radius:50%; background:var(--m) }
.slug-add { display:flex; gap:6px; margin-top:4px }
.slug-add input { flex:1; background:var(--s2); border:1px solid var(--b); color:var(--t); border-radius:6px; padding:7px 10px; font-size:12px; outline:none }
.slug-add button { background:var(--s3); border:1px solid var(--b); color:var(--t); border-radius:6px; padding:7px 12px; font-size:12px; cursor:pointer }

/* Main panels */
.panel { display:none }
.panel.active { display:block }
.panel-title { font-size:17px; font-weight:600; margin-bottom:6px }
.panel-sub   { font-size:12px; color:var(--m); margin-bottom:28px }

/* Forms */
.form { display:flex; flex-direction:column; gap:14px; max-width:560px }
.row  { display:grid; grid-template-columns:1fr 1fr; gap:12px }
.field { display:flex; flex-direction:column; gap:5px }
.field label { font-size:11px; color:var(--m); text-transform:uppercase; letter-spacing:.05em }
input, select {
  background:var(--s1); border:1px solid var(--b); color:var(--t);
  border-radius:8px; padding:9px 13px; font-size:13px; outline:none; width:100%;
}
input:focus, select:focus { border-color:#444 }
input::placeholder { color:var(--m2) }
.hint { font-size:11px; color:var(--m2); margin-top:2px }
.divider { height:1px; background:var(--b); margin:4px 0 }

/* Buttons */
.btn {
  display:inline-flex; align-items:center; gap:8px;
  background:var(--s2); border:1px solid var(--b); color:var(--t);
  border-radius:8px; padding:10px 18px; font-size:13px; font-weight:500;
  cursor:pointer; transition:background .15s; white-space:nowrap;
}
.btn:hover { background:var(--s3) }
.btn:disabled { opacity:.35; cursor:default }
.btn.primary { background:var(--accent)22; border-color:var(--accent)44; color:var(--accent) }
.btn.primary:hover { background:var(--accent)33 }
.btn-row { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin-top:4px }

/* Card scan area */
.scan-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:20px }
.cam-selector { display:flex; gap:6px }
.cam-btn {
  width:36px; height:36px; border-radius:8px; border:1px solid var(--b);
  background:var(--s2); color:var(--m); font-size:13px; font-weight:600;
  cursor:pointer; display:flex; align-items:center; justify-content:center;
  transition:all .15s;
}
.cam-btn:hover  { border-color:#444; color:var(--t) }
.cam-btn.active { border-color:var(--accent); background:var(--accent)22; color:var(--accent) }

/* Thumb grid */
.thumb-grid {
  display:grid; grid-template-columns:repeat(auto-fill,minmax(190px,1fr)); gap:10px;
  margin:20px 0;
}
.thumb-card {
  background:var(--s1); border:1px solid var(--b); border-radius:8px; overflow:hidden;
}
.thumb-img { position:relative; aspect-ratio:16/9; background:#000; cursor:zoom-in }
.thumb-img img  { width:100%; height:100%; object-fit:cover; display:block }
.thumb-ph { width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:var(--m2); font-size:11px }
.thumb-badge {
  position:absolute; top:6px; right:6px;
  font-size:9px; font-weight:600; padding:2px 6px; border-radius:4px;
  background:rgba(0,0,0,.75); color:#aaa;
}
.thumb-badge.done    { color:var(--green) }
.thumb-badge.active  { color:var(--accent) }
.thumb-badge.backup  { color:var(--blue) }
.thumb-footer { padding:8px 10px 10px }
.thumb-name { font-family:monospace; font-size:10px; color:var(--t); white-space:nowrap; overflow:hidden; text-overflow:ellipsis }
.thumb-slug-sel {
  margin-top:5px; width:100%; background:var(--s2); border:1px solid var(--b);
  color:var(--m); border-radius:5px; padding:4px 7px; font-size:11px; outline:none;
}
.thumb-slug-sel:focus { border-color:#444 }

/* Lightbox */
.lb { display:none; position:fixed; inset:0; background:rgba(0,0,0,.92); z-index:200; align-items:center; justify-content:center; cursor:zoom-out }
.lb.open { display:flex }
.lb img { max-width:90vw; max-height:90vh; border-radius:4px }
.lb-lbl { position:fixed; bottom:20px; left:50%; transform:translateX(-50%); font-family:monospace; font-size:11px; color:#aaa; background:rgba(0,0,0,.7); padding:5px 12px; border-radius:6px }

/* Progress log */
.log { background:var(--s1); border:1px solid var(--b); border-radius:8px; padding:12px 14px; font-family:monospace; font-size:11px; color:var(--m); max-height:160px; overflow-y:auto; line-height:1.7; margin:16px 0 }

/* Story ALE table */
.story-table { width:100%; border-collapse:collapse; margin-top:16px; font-size:12px }
.story-table th { text-align:left; padding:8px 12px; color:var(--m); font-weight:500; border-bottom:1px solid var(--b) }
.story-table td { padding:8px 12px; border-bottom:1px solid var(--b)55 }
.cam-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px }
.downloads { display:flex; gap:8px; flex-wrap:wrap; margin-top:20px }
.dl-btn {
  display:inline-flex; align-items:center; gap:8px;
  background:var(--s1); border:1px solid var(--b);
  border-radius:8px; padding:9px 14px; font-size:12px; color:var(--t); cursor:pointer;
  transition:background .15s;
}
.dl-btn:hover { background:var(--s2) }
.dl-btn a { color:inherit; text-decoration:none }

/* Queue */
.queue-list { display:flex; flex-direction:column; gap:8px; margin:16px 0 }
.queue-item {
  display:flex; align-items:center; justify-content:space-between;
  background:var(--s1); border:1px solid var(--b); border-radius:8px; padding:10px 14px;
}
.queue-item-info { display:flex; flex-direction:column; gap:3px }
.queue-item-title { font-size:13px; font-weight:500 }
.queue-item-meta  { font-size:11px; color:var(--m) }
.queue-status { font-size:11px; padding:3px 8px; border-radius:4px; background:var(--s2); color:var(--m) }
.queue-status.done { background:var(--green)15; color:var(--green) }
.queue-status.active { background:var(--accent)15; color:var(--accent) }
</style>
</head>
<body>
<div class="app">

  <!-- Sidebar -->
  <aside class="sidebar">
    <div>
      <div class="logo">POSTIE RUSHES</div>
      <div class="show-badge">${SHOW}</div>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Session</div>
      <div id="sessionInfo" style="font-size:12px;color:var(--m)">No session</div>
      <button class="btn" style="font-size:12px;padding:7px 12px" onclick="showPanel('session')">
        New / switch session
      </button>
    </div>

    <div class="sidebar-section">
      <div class="sidebar-label">Stories this season</div>
      <div class="slug-list" id="slugList"></div>
      <div class="slug-add">
        <input id="newSlugInput" placeholder="New story slug…" maxlength="20"
          onkeydown="if(event.key==='Enter')addSlug()">
        <button onclick="addSlug()">+</button>
      </div>
    </div>

    <div style="flex:1"></div>
    <div style="font-size:10px;color:var(--m2)">localhost:${PORT}</div>
  </aside>

  <!-- Main -->
  <main class="main">

    <!-- Panel: session setup -->
    <div id="panel-session" class="panel active">
      <div class="panel-title">Session setup</div>
      <div class="panel-sub">Configure a shoot day. Settings persist for the session.</div>
      <form class="form" id="sessionForm">
        <div class="row">
          <div class="field">
            <label>Shoot date (MMDD)</label>
            <input name="date" id="dateInput" maxlength="4" placeholder="0524" required>
          </div>
          <div class="field">
            <label>Log format</label>
            <select name="log">
              <option value="none">None — already Rec.709</option>
              <option value="slog2">S-Log2 → 709 (Sony)</option>
              <option value="slog3">S-Log3 → 709 (Sony)</option>
              <option value="dlogm">D-Log M → 709 (DJI)</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>Output root</label>
          <input name="output" placeholder="/Volumes/AvidServer/Ingest" required>
        </div>
        <div class="field">
          <label>Backup drive</label>
          <input name="backup" placeholder="/Volumes/PGHI_BACKUP">
          <span class="hint">Camera originals are copied here before transcoding</span>
        </div>
        <div class="field">
          <label>AvidMediaFiles path</label>
          <input name="avid" placeholder="/Volumes/AvidServer/AvidMediaFiles/MXF/1">
          <span class="hint">Proxies move here automatically once verified</span>
        </div>
        <div class="row">
          <div class="field">
            <label>Frame rate</label>
            <select name="fps">
              <option value="25" selected>25</option>
              <option value="29.97">29.97</option>
              <option value="50">50</option>
              <option value="23.976">23.976</option>
              <option value="24">24</option>
            </select>
          </div>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn primary">Create session →</button>
        </div>
      </form>
    </div>

    <!-- Panel: scan card -->
    <div id="panel-scan" class="panel">
      <div class="panel-title">Scan card</div>
      <div class="panel-sub">Scan a camera card. Assign each clip to a story, then add to the ingest queue.</div>

      <div class="form" style="max-width:560px;margin-bottom:24px">
        <div class="row">
          <div class="field">
            <label>Card path</label>
            <input id="cardPath" placeholder="/Volumes/CARD_001">
          </div>
          <div class="field">
            <label>Camera</label>
            <div class="cam-selector" id="camSelector">
              ${['A','B','C','D'].map(c => `<button type="button" class="cam-btn" data-cam="${c}" onclick="selectCam('${c}')">${c}</button>`).join('')}
            </div>
          </div>
        </div>
        <div class="field">
          <label>Default story</label>
          <select id="defaultSlug"></select>
        </div>
        <div class="btn-row">
          <button class="btn primary" id="scanBtn" onclick="startScan()">Scan card</button>
          <span id="cardNumLabel" style="font-size:12px;color:var(--m)"></span>
        </div>
      </div>

      <div id="scanLog" class="log" style="display:none"></div>

      <div id="thumbGrid" class="thumb-grid"></div>

      <div id="addQueueRow" class="btn-row" style="display:none">
        <button class="btn primary" onclick="addToQueue()">Add to ingest queue →</button>
        <button class="btn" onclick="clearScan()">Discard scan</button>
      </div>
    </div>

    <!-- Panel: ingest queue -->
    <div id="panel-ingest" class="panel">
      <div class="panel-title">Ingest queue</div>
      <div class="panel-sub">Review queued cards and start ingest. Backup → Transcode → Verify → Move to Avid.</div>

      <div class="queue-list" id="queueList"></div>

      <div class="btn-row" style="margin-top:8px">
        <button class="btn primary" id="ingestBtn" onclick="startIngest()">Start ingest</button>
        <button class="btn" onclick="showPanel('scan')">← Add more cards</button>
      </div>

      <div id="ingestLog" class="log" style="display:none"></div>

      <div id="storyResults"></div>
    </div>

  </main>
</div>

<!-- Lightbox -->
<div class="lb" id="lb" onclick="this.classList.remove('open')">
  <img id="lbImg" src="" alt="">
  <div class="lb-lbl" id="lbLbl"></div>
</div>

<script>
// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let db          = null   // full db snapshot
let session     = null   // current session object
let currentScan = null   // { scanId, clips, cam, cardPath }
let selectedCam = 'A'
const queue     = []     // array of { scanId, card metadata }

const CAM_COLORS = { A:'#67e8f9', B:'#60a5fa', C:'#4ade80', D:'#e879f9', E:'#facc15', F:'#f87171' }

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
async function init() {
  const res  = await fetch('/api/db')
  db         = await res.json()
  renderSlugs()

  // Pre-fill today's date
  const n = new Date()
  document.getElementById('dateInput').value =
    String(n.getMonth()+1).padStart(2,'0') + String(n.getDate()).padStart(2,'0')

  selectCam('A')
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------
function renderSlugs() {
  const list = document.getElementById('slugList')
  list.innerHTML = ''
  for (const s of (db?.slugs ?? [])) {
    const el = document.createElement('div')
    el.className = 'slug-item'
    el.dataset.slug = s.name
    el.innerHTML = '<span>' + s.name + '</span><div class="slug-dot"></div>'
    list.appendChild(el)
  }
  refreshDefaultSlugSelect()
}

function refreshDefaultSlugSelect() {
  const sel  = document.getElementById('defaultSlug')
  const prev = sel.value
  sel.innerHTML = ''
  for (const s of (db?.slugs ?? [])) {
    const o = document.createElement('option')
    o.value = o.textContent = s.name
    sel.appendChild(o)
  }
  if (prev) sel.value = prev
}

async function addSlug() {
  const input = document.getElementById('newSlugInput')
  const name  = input.value.trim()
  if (!name) return
  const res = await fetch('/api/slug', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })
  db = await res.json()
  input.value = ''
  renderSlugs()
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
document.getElementById('sessionForm').addEventListener('submit', async e => {
  e.preventDefault()
  const data = Object.fromEntries(new FormData(e.target))
  const res  = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ show: '${SHOW}', ...data }),
  })
  const j = await res.json()
  session = j.session
  db      = j.db
  renderSlugs()
  document.getElementById('sessionInfo').textContent = session.date + ' — ' + (session.output.split('/').pop() || session.output)
  showPanel('scan')
})

// ---------------------------------------------------------------------------
// Panel navigation
// ---------------------------------------------------------------------------
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'))
  document.getElementById('panel-' + name).classList.add('active')
}

// ---------------------------------------------------------------------------
// Camera selection
// ---------------------------------------------------------------------------
function selectCam(cam) {
  selectedCam = cam
  document.querySelectorAll('.cam-btn').forEach(b => b.classList.toggle('active', b.dataset.cam === cam))
  updateCardNumLabel()
}

function updateCardNumLabel() {
  if (!session) return
  const existing = (session.cards ?? []).filter(c => c.cam === selectedCam).length
  document.getElementById('cardNumLabel').textContent = 'CARD ' + String(existing + 1).padStart(3,'0')
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
async function startScan() {
  if (!session) { alert('Create a session first'); return }
  const cardPath    = document.getElementById('cardPath').value.trim()
  const defaultSlug = document.getElementById('defaultSlug').value
  if (!cardPath) { alert('Enter a card path'); return }

  document.getElementById('scanBtn').disabled = true
  document.getElementById('scanLog').style.display = 'block'
  document.getElementById('scanLog').innerHTML = ''
  document.getElementById('thumbGrid').innerHTML = ''
  document.getElementById('addQueueRow').style.display = 'none'
  currentScan = null

  const cardNum = (session.cards ?? []).filter(c => c.cam === selectedCam).length + 1

  const res = await fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.id,
      inputPath: cardPath,
      cam: selectedCam,
      cardNum,
      defaultSlug,
    }),
  })
  const { scanId, error } = await res.json()
  if (error) { appendScanLog('Error: ' + error); document.getElementById('scanBtn').disabled = false; return }

  currentScan = { scanId, clips: [], cam: selectedCam, cardNum, cardPath }

  const es = new EventSource('/api/scan-events/' + scanId)
  es.addEventListener('log',     e => appendScanLog(e.data))
  es.addEventListener('preview', e => {
    const clip = JSON.parse(e.data)
    currentScan.clips.push(clip)
    addThumbCard(clip, defaultSlug)
  })
  es.addEventListener('done', e => {
    es.close()
    document.getElementById('scanBtn').disabled = false
    if (currentScan.clips.length > 0) {
      document.getElementById('addQueueRow').style.display = 'flex'
    }
  })
  es.addEventListener('error', e => {
    const d = e.data ? JSON.parse(e.data) : {}
    appendScanLog('Error: ' + (d.message ?? 'scan failed'))
    es.close()
    document.getElementById('scanBtn').disabled = false
  })
}

function appendScanLog(msg) {
  const el = document.getElementById('scanLog')
  const line = document.createElement('div')
  line.textContent = msg
  el.appendChild(line)
  el.scrollTop = el.scrollHeight
}

function addThumbCard(clip, defaultSlug) {
  const grid = document.getElementById('thumbGrid')
  const card = document.createElement('div')
  card.className = 'thumb-card'
  card.id = 'tc_' + clip.name

  const imgWrap = document.createElement('div')
  imgWrap.className = 'thumb-img'

  if (clip.previewPath) {
    const img = document.createElement('img')
    img.src = '/api/preview?path=' + encodeURIComponent(clip.previewPath)
    img.alt = clip.name
    img.onclick = () => openLightbox(img.src, clip.name)
    imgWrap.appendChild(img)
  } else {
    const ph = document.createElement('div')
    ph.className = 'thumb-ph'
    ph.textContent = 'no preview'
    imgWrap.appendChild(ph)
  }

  const badge = document.createElement('div')
  badge.className = 'thumb-badge'
  badge.textContent = clip.codec + ' ' + clip.width + '×' + clip.height
  imgWrap.appendChild(badge)

  const footer = document.createElement('div')
  footer.className = 'thumb-footer'
  const nameEl = document.createElement('div')
  nameEl.className = 'thumb-name'
  nameEl.textContent = clip.originalName
  nameEl.title = clip.name

  const slugSel = document.createElement('select')
  slugSel.className = 'thumb-slug-sel'
  for (const s of (db?.slugs ?? [])) {
    const o = document.createElement('option')
    o.value = o.textContent = s.name
    slugSel.appendChild(o)
  }
  slugSel.value = defaultSlug ?? ''
  slugSel.onchange = () => {
    const c = currentScan.clips.find(c => c.name === clip.name)
    if (c) c.slug = slugSel.value
  }

  footer.appendChild(nameEl)
  footer.appendChild(slugSel)
  card.appendChild(imgWrap)
  card.appendChild(footer)
  grid.appendChild(card)
}

function clearScan() {
  currentScan = null
  document.getElementById('thumbGrid').innerHTML = ''
  document.getElementById('scanLog').style.display = 'none'
  document.getElementById('addQueueRow').style.display = 'none'
}

// ---------------------------------------------------------------------------
// Queue
// ---------------------------------------------------------------------------
async function addToQueue() {
  if (!currentScan) return
  // Commit slug assignments to server
  await fetch('/api/scan-commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.id,
      scanId:    currentScan.scanId,
      clips:     currentScan.clips.map(c => ({ name: c.name, slug: c.slug })),
    }),
  })

  // Refresh session
  const res2 = await fetch('/api/session/' + session.id)
  session    = await res2.json()

  queue.push({ ...currentScan })
  renderQueue()
  clearScan()
  showPanel('ingest')
  updateCardNumLabel()
}

function renderQueue() {
  const list = document.getElementById('queueList')
  list.innerHTML = ''
  for (const item of queue) {
    const el = document.createElement('div')
    el.className = 'queue-item'
    el.id = 'qi_' + item.scanId

    const info = document.createElement('div')
    info.className = 'queue-item-info'
    info.innerHTML = '<div class="queue-item-title">CAM ' + item.cam + ' — CARD ' + String(item.cardNum).padStart(3,'0') + '</div>' +
      '<div class="queue-item-meta">' + item.cardPath + ' · ' + item.clips.length + ' clips</div>'

    const status = document.createElement('div')
    status.className = 'queue-status'
    status.textContent = 'queued'
    status.id = 'qs_' + item.scanId

    el.appendChild(info)
    el.appendChild(status)
    list.appendChild(el)
  }
  document.getElementById('ingestBtn').disabled = queue.length === 0
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------
async function startIngest() {
  if (!session || queue.length === 0) return
  document.getElementById('ingestBtn').disabled = true
  document.getElementById('ingestLog').style.display = 'block'
  document.getElementById('ingestLog').innerHTML = ''

  const res = await fetch('/api/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id }),
  })
  const { jobId, error } = await res.json()
  if (error) { appendIngestLog('Error: ' + error); document.getElementById('ingestBtn').disabled = false; return }

  const es = new EventSource('/api/ingest-events/' + jobId)
  es.addEventListener('log',      e => appendIngestLog(e.data))
  es.addEventListener('backup',   e => setQueueStatus(JSON.parse(e.data).cardId, 'backing up…', 'active'))
  es.addEventListener('transcode',e => {
    const p = JSON.parse(e.data)
    if (p.status === 'started') setClipBadge(p.clip, 'active')
    if (p.status === 'done')    setClipBadge(p.clip, 'done')
    setQueueStatus(p.cardId, p.index + '/' + p.total, 'active')
  })
  es.addEventListener('card-done', e => {
    const p = JSON.parse(e.data)
    setQueueStatus(p.cardId, 'done', 'done')
  })
  es.addEventListener('done', e => {
    const result = JSON.parse(e.data)
    es.close()
    renderStoryResults(result)
  })
  es.addEventListener('error', e => {
    const d = e.data ? JSON.parse(e.data) : {}
    appendIngestLog('Error: ' + (d.message ?? 'unknown'))
    es.close()
    document.getElementById('ingestBtn').disabled = false
  })
}

function appendIngestLog(msg) {
  const el = document.getElementById('ingestLog')
  const line = document.createElement('div')
  line.textContent = msg
  el.appendChild(line)
  el.scrollTop = el.scrollHeight
}

function setQueueStatus(cardId, text, cls) {
  const el = document.querySelector('[id^="qs_"]')
  if (!el) return
  // find by cardId in queue mapping — simplified
  document.querySelectorAll('.queue-status').forEach(s => {
    if (s.dataset.cardId === cardId) {
      s.textContent = text
      s.className = 'queue-status ' + (cls ?? '')
    }
  })
}

function setClipBadge(clipName, status) {
  const el = document.getElementById('tc_' + clipName)
  if (!el) return
  const badge = el.querySelector('.thumb-badge')
  if (badge) { badge.className = 'thumb-badge ' + status }
}

function renderStoryResults(result) {
  const el = document.getElementById('storyResults')
  el.innerHTML = '<div style="font-size:13px;font-weight:600;margin:24px 0 12px">Story ALEs</div>'

  const dl = document.createElement('div')
  dl.className = 'downloads'

  for (const { slug, alePath, fcpxmlPath, clipCount } of result.stories) {
    if (alePath) {
      const a = document.createElement('a')
      a.className = 'dl-btn'
      a.href = '/api/download?path=' + encodeURIComponent(alePath)
      a.download = basename(alePath)
      a.textContent = '↓ ' + basename(alePath) + ' (' + clipCount + ' clips)'
      dl.appendChild(a)
    }
    if (fcpxmlPath) {
      const a = document.createElement('a')
      a.className = 'dl-btn'
      a.href = '/api/download?path=' + encodeURIComponent(fcpxmlPath)
      a.download = basename(fcpxmlPath)
      a.textContent = '↓ ' + basename(fcpxmlPath)
      dl.appendChild(a)
    }
  }

  el.appendChild(dl)
}

function basename(p) { return p.split('/').pop() }

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------
function openLightbox(src, name) {
  document.getElementById('lbImg').src  = src
  document.getElementById('lbLbl').textContent = name
  document.getElementById('lb').classList.add('open')
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
init()
</script>
</body>
</html>`

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)

  const json = (data, status = 200) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  const body = () => new Promise(r => {
    let b = ''
    req.on('data', d => { b += d })
    req.on('end', () => { try { r(JSON.parse(b)) } catch { r({}) } })
  })

  // UI
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(HTML)
    return
  }

  // DB snapshot
  if (req.method === 'GET' && url.pathname === '/api/db') {
    json(loadDb(SHOW))
    return
  }

  // Add slug
  if (req.method === 'POST' && url.pathname === '/api/slug') {
    const { name } = await body()
    const db = loadDb(SHOW)
    addSlug(db, name)
    saveDb(SHOW, db)
    json(db)
    return
  }

  // Create/get session
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const params = await body()
    const db     = loadDb(SHOW)
    const today  = new Date()
    const date   = params.date || (String(today.getMonth()+1).padStart(2,'0') + String(today.getDate()).padStart(2,'0'))
    const session = getOrCreateSession(db, { ...params, date })
    saveDb(SHOW, db)
    json({ session, db })
    return
  }

  // Get session
  if (req.method === 'GET' && url.pathname.startsWith('/api/session/')) {
    const sessionId = url.pathname.split('/api/session/')[1]
    const db        = loadDb(SHOW)
    const session   = getSession(db, sessionId)
    if (!session) { json({ error: 'Session not found' }, 404); return }
    json(session)
    return
  }

  // Scan a card
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    const params    = await body()
    const db        = loadDb(SHOW)
    const session   = getSession(db, params.sessionId)
    if (!session) { json({ error: 'Session not found' }, 404); return }

    const scanId = randomUUID()
    const jobId  = createJob()
    scans.set(scanId, { jobId, clips: [], params })

    json({ scanId })

    // Run scan async
    scanCard(
      {
        inputPath: params.inputPath,
        cam:       params.cam,
        cardNum:   params.cardNum,
        date:      session.date,
        slug:      params.defaultSlug,
        output:    session.output,
        log:       session.log,
        fps:       session.fps,
      },
      (event) => {
        const scan = scans.get(scanId)
        if (!scan) return
        emitToJob(scan.jobId, event.type, event.type === 'preview' ? event.clip : event.data)
        if (event.type === 'preview') scan.clips.push(event.clip)
      }
    ).then(() => {
      emitToJob(scans.get(scanId)?.jobId, 'done', { scanId })
    }).catch(err => {
      emitToJob(scans.get(scanId)?.jobId, 'error', { message: err.message })
    })
    return
  }

  // SSE for scan progress
  if (req.method === 'GET' && url.pathname.startsWith('/api/scan-events/')) {
    const scanId = url.pathname.split('/api/scan-events/')[1]
    const scan   = scans.get(scanId)
    if (!scan) { res.writeHead(404); res.end(); return }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })

    const job = jobs.get(scan.jobId)
    for (const ev of job.events) {
      res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`)
    }

    if (!job.clients.includes(res)) job.clients.push(res)
    req.on('close', () => { job.clients = job.clients.filter(c => c !== res) })
    return
  }

  // Commit scan → add card to session
  if (req.method === 'POST' && url.pathname === '/api/scan-commit') {
    const { sessionId, scanId, clips: assignments } = await body()
    const db      = loadDb(SHOW)
    const session = getSession(db, sessionId)
    if (!session) { json({ error: 'Session not found' }, 404); return }

    const scan = scans.get(scanId)
    if (!scan) { json({ error: 'Scan not found' }, 404); return }

    // Apply slug assignments
    for (const clip of scan.clips) {
      const assign = assignments.find(a => a.name === clip.name)
      if (assign) clip.slug = assign.slug
    }

    addCard(session, { inputPath: scan.params.inputPath, cam: scan.params.cam, clips: scan.clips })
    saveDb(SHOW, db)
    json({ ok: true })
    return
  }

  // Start ingest
  if (req.method === 'POST' && url.pathname === '/api/ingest') {
    const { sessionId } = await body()
    const db            = loadDb(SHOW)
    const session       = getSession(db, sessionId)
    if (!session) { json({ error: 'Session not found' }, 404); return }

    const jobId = createJob()
    json({ jobId })

    // Run ingest async
    ;(async () => {
      const emit = (type, data) => emitToJob(jobId, type, data)

      for (const card of session.cards) {
        if (card.status === 'complete') continue

        updateCardStatus(session, card.id, 'ingesting')
        saveDb(SHOW, db)

        // 1. Backup
        emit('backup', { cardId: card.id })
        try {
          await backupCard({ card, date: session.date, backupRoot: session.backup }, (ev) => emit(ev.type, ev.data))
        } catch (e) {
          emit('log', `Backup warning: ${e.message}`)
        }

        // 2. Transcode → stage → move
        let index = 0
        for (const clip of card.clips) {
          index++
          emit('transcode', { cardId: card.id, clip: clip.name, index, total: card.clips.length, status: 'started' })
          emit('log', `[${index}/${card.clips.length}] ${clip.name}`)
          try {
            await transcodeCard(
              { card: { ...card, clips: [clip] }, date: session.date, output: session.output, avid: session.avid, log: session.log, fps: session.fps },
              (ev) => emit(ev.type, { ...ev.data, cardId: card.id })
            )
            emit('transcode', { cardId: card.id, clip: clip.name, index, total: card.clips.length, status: 'done' })
          } catch (e) {
            emit('log', `Error on ${clip.name}: ${e.message}`)
          }
        }

        updateCardStatus(session, card.id, 'complete')
        saveDb(SHOW, db)
        emit('card-done', { cardId: card.id })
      }

      // Build combined per-story ALEs
      const storyMap = clipsBySlug(session)
      const stories  = []

      mkdirSync(session.output, { recursive: true })

      for (const [slug, clips] of Object.entries(storyMap)) {
        const aleContent    = buildALE(clips, session.fps, slug, session.date)
        const fcpxmlContent = buildFCPXML(clips, session.fps, slug, session.date, session.output)
        const alePath       = join(session.output, `${session.date}_${slug}.ale`)
        const fcpxmlPath    = join(session.output, `${session.date}_${slug}.fcpxml`)

        writeFileSync(alePath,    aleContent,    'utf8')
        writeFileSync(fcpxmlPath, fcpxmlContent, 'utf8')

        emit('log', `ALE: ${alePath} (${clips.length} clips)`)
        stories.push({ slug, alePath, fcpxmlPath, clipCount: clips.length })
      }

      emit('done', { stories })
    })().catch(err => emitToJob(jobId, 'error', { message: err.message }))
    return
  }

  // SSE for ingest
  if (req.method === 'GET' && url.pathname.startsWith('/api/ingest-events/')) {
    const jobId = url.pathname.split('/api/ingest-events/')[1]
    const job   = jobs.get(jobId)
    if (!job) { res.writeHead(404); res.end(); return }

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' })
    for (const ev of job.events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`)
    job.clients.push(res)
    req.on('close', () => { job.clients = job.clients.filter(c => c !== res) })
    return
  }

  // Serve preview image
  if (req.method === 'GET' && url.pathname === '/api/preview') {
    const filePath = url.searchParams.get('path')
    if (!filePath || !existsSync(filePath)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600' })
    res.end(readFileSync(filePath))
    return
  }

  // Download file
  if (req.method === 'GET' && url.pathname === '/api/download') {
    const filePath = url.searchParams.get('path')
    if (!filePath || !existsSync(filePath)) { res.writeHead(404); res.end(); return }
    res.writeHead(200, {
      'Content-Disposition': `attachment; filename="${basename(filePath)}"`,
      'Content-Type': 'application/octet-stream',
    })
    res.end(readFileSync(filePath))
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nPostie Rushes — ${SHOW}\nhttp://localhost:${PORT}\n`)
})
