#!/usr/bin/env node
/**
 * postie-rushes  —  camera card ingest tool
 *
 * Usage:  node rushes.mjs --show <CODE> [--port 4321]
 */

import { createServer }                          from 'http'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { basename, dirname, join }               from 'path'
import { fileURLToPath }                         from 'url'
import { execSync, spawnSync }                   from 'child_process'
import { parseArgs }                             from 'util'
import { randomUUID }                            from 'crypto'

import { getShow, getSlugs, addSlug,
         getOrCreateSession, getSession, getSessionWithCards,
         nextCardNum, addCard, updateCardStatus,
         addClip, clipsBySlug }                  from './lib/db.mjs'
import { detectRelays }                          from './lib/relay.mjs'
import { buildALE, buildFCPXML }                 from './lib/formats.mjs'
import { scanCard, backupCard, transcodeCard,
         transcodeRelayGroup, commitSessionToAvid } from './lib/ingest.mjs'

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    show: { type: 'string' },
    port: { type: 'string', default: '4321' },
    help: { type: 'boolean', default: false },
  },
  strict: false,
})

if (args.help) {
  console.log('Usage: node rushes.mjs --show <CODE> [--port 4321]')
  process.exit(0)
}

if (!args.show) {
  console.error('Error: --show <CODE> is required (e.g. --show PGHI)')
  process.exit(1)
}

const SHOW = args.show.toUpperCase()
const PORT = parseInt(args.port)

let show = null

// ---------------------------------------------------------------------------
// In-memory job state
// ---------------------------------------------------------------------------

const jobs = new Map()   // jobId → { events[], clients[] }
const scans = new Map()  // scanId → { jobId, clips[], params }

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
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0d0d0d;--s1:#141414;--s2:#1a1a1a;--s3:#222;
  --b:#2c2c2c;--t:#e0e0e0;--m:#777;--m2:#444;
  --accent:#E63946;--green:#4ade80;--blue:#60a5fa;--yellow:#facc15;
  --r:8px;
}
body{background:var(--bg);color:var(--t);font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.5}

/* Layout */
.page{max-width:940px;margin:0 auto;padding:0 18px 80px}

/* Header */
.hdr{display:flex;align-items:center;gap:10px;padding:14px 0 12px;border-bottom:1px solid var(--b);margin-bottom:20px}
.hdr-logo{font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--accent)}
.hdr-show{font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;background:var(--accent)22;color:var(--accent)}
.hdr-session{margin-left:auto;font-size:11px;color:var(--m)}

/* Cards (sections) */
.card{border:1px solid var(--b);border-radius:var(--r);margin-bottom:14px;overflow:hidden}
.card-head{
  display:flex;align-items:center;gap:10px;
  padding:11px 16px;background:var(--s1);
  cursor:pointer;user-select:none;
}
.card-head:hover{background:var(--s2)}
.card-num{font-size:10px;font-weight:700;color:var(--accent);min-width:16px}
.card-title{font-size:12px;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.card-summary{margin-left:auto;font-size:11px;color:var(--m)}
.card-chevron{font-size:9px;color:var(--m2);margin-left:6px;transition:transform .18s}
.card-head.closed .card-chevron{transform:rotate(-90deg)}
.card-body{padding:16px;border-top:1px solid var(--b)}
.card-body.hidden{display:none}

/* Forms */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.span2{grid-column:span 2}
.field{display:flex;flex-direction:column;gap:4px}
.field label{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;color:var(--m)}
.hint{font-size:10px;color:var(--m2)}
input,select{
  background:var(--bg);border:1px solid var(--b);color:var(--t);
  border-radius:6px;padding:8px 10px;font-size:12px;outline:none;width:100%;
}
input:focus,select:focus{border-color:#3a3a3a}
input::placeholder{color:var(--m2)}

/* Path row with browse */
.path-row{display:flex;gap:6px}
.path-row input{flex:1}
.path-drop-active{border-color:var(--accent)!important;background:var(--accent)0a!important}

/* Buttons */
.btn{
  display:inline-flex;align-items:center;gap:6px;
  background:var(--s2);border:1px solid var(--b);color:var(--t);
  border-radius:6px;padding:8px 14px;font-size:12px;font-weight:500;
  cursor:pointer;white-space:nowrap;transition:background .12s;
}
.btn:hover{background:var(--s3)}
.btn:disabled{opacity:.35;cursor:default}
.btn.primary{background:var(--accent)20;border-color:var(--accent)55;color:var(--accent)}
.btn.primary:hover{background:var(--accent)30}
.btn.sm{padding:5px 10px;font-size:11px}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px}

/* Camera selector */
.cam-row{display:flex;gap:5px}
.cam-btn{
  width:32px;height:32px;border-radius:6px;
  border:1px solid var(--b);background:var(--s2);color:var(--m);
  font-size:12px;font-weight:600;cursor:pointer;
  display:flex;align-items:center;justify-content:center;
}
.cam-btn:hover{border-color:#3a3a3a;color:var(--t)}
.cam-btn.active{border-color:var(--accent);background:var(--accent)20;color:var(--accent)}

/* Story chips */
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.chip{
  font-size:11px;font-weight:600;padding:3px 10px;border-radius:20px;
  background:var(--s2);border:1px solid var(--b);cursor:default;
}

/* Thumb grid */
.thumbs{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:9px;margin-top:14px}
.thumb{background:var(--s1);border:1px solid var(--b);border-radius:var(--r);overflow:hidden}
.thumb-img{position:relative;aspect-ratio:16/9;background:#000;cursor:zoom-in}
.thumb-img img{width:100%;height:100%;object-fit:cover;display:block}
.thumb-ph{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--m2);font-size:10px}
.thumb-badge{
  position:absolute;top:5px;right:5px;
  font-size:9px;font-weight:600;padding:2px 5px;border-radius:3px;
  background:rgba(0,0,0,.8);color:var(--m);
}
.thumb-badge.xcode{color:var(--yellow)}
.thumb-badge.done{color:var(--green)}
.thumb-foot{padding:7px 8px 8px}
.thumb-name{font-family:monospace;font-size:9px;color:var(--m);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px}
.thumb-foot select{background:var(--s2);border:1px solid var(--b);color:var(--t);border-radius:4px;padding:3px 6px;font-size:11px;width:100%}

/* Queue */
.q-list{display:flex;flex-direction:column;gap:7px}
.q-item{display:flex;align-items:center;gap:12px;background:var(--s2);border:1px solid var(--b);border-radius:6px;padding:9px 13px}
.q-info{flex:1}
.q-title{font-size:12px;font-weight:500}
.q-meta{font-size:10px;color:var(--m);margin-top:1px}
.q-chip{font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;background:var(--s1);border:1px solid var(--b);color:var(--m)}
.q-chip.backing{color:var(--blue);background:#60a5fa12;border-color:#60a5fa30}
.q-chip.running{color:var(--yellow);background:#facc1512;border-color:#facc1530}
.q-chip.done{color:var(--green);background:#4ade8012;border-color:#4ade8030}
.q-chip.err{color:var(--accent);background:var(--accent)12;border-color:var(--accent)30}
.q-empty{color:var(--m2);font-size:12px;text-align:center;padding:20px 0}

/* Progress */
.prog-status{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
.prog-op{font-size:12px;font-weight:500}
.prog-frac{font-size:11px;color:var(--m)}
.prog-bar-wrap{height:3px;background:var(--b);border-radius:2px;overflow:hidden;margin-bottom:14px}
.prog-bar{height:100%;background:var(--accent);border-radius:2px;transition:width .4s ease;width:0%}

/* Log */
.log{
  background:var(--bg);border:1px solid var(--b);border-radius:6px;
  padding:10px 12px;font-family:'Consolas','Courier New',monospace;font-size:11px;
  line-height:1.85;max-height:420px;overflow-y:auto;
}
.log-line{display:flex;gap:10px}
.log-ts{color:var(--m2);flex-shrink:0;width:38px;font-size:10px;padding-top:1px}
.log-txt{word-break:break-all}
.log-txt.info{color:var(--m)}
.log-txt.backup{color:var(--blue)}
.log-txt.xcode{color:var(--yellow)}
.log-txt.ok{color:var(--green)}
.log-txt.err{color:var(--accent)}

/* Downloads */
.ale-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.ale-btn{
  display:inline-flex;align-items:center;gap:6px;
  background:var(--s2);border:1px solid var(--b);
  border-radius:6px;padding:7px 12px;font-size:11px;color:var(--t);text-decoration:none;
}
.ale-btn:hover{background:var(--s3)}

/* Lightbox */
.lb{display:none;position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:100;align-items:center;justify-content:center;cursor:zoom-out}
.lb.open{display:flex}
.lb img{max-width:90vw;max-height:90vh;border-radius:4px}
.lb-lbl{position:fixed;bottom:14px;left:50%;transform:translateX(-50%);font-family:monospace;font-size:10px;color:#aaa;background:rgba(0,0,0,.7);padding:4px 10px;border-radius:4px}
</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="hdr">
    <span class="hdr-logo">POSTIE RUSHES</span>
    <span class="hdr-show">${SHOW}</span>
    <span class="hdr-session" id="hdrSession">No session</span>
  </div>

  <!-- 1 · Session -->
  <div class="card" id="c-session">
    <div class="card-head" onclick="toggleCard('session')">
      <span class="card-num">1</span>
      <span class="card-title">Session</span>
      <span class="card-summary" id="cs-session"></span>
      <span class="card-chevron">▼</span>
    </div>
    <div class="card-body" id="cb-session">
      <form id="sessionForm">
        <div class="grid">
          <div class="field">
            <label>Shoot date <small style="font-weight:400;text-transform:none">(MMDD)</small></label>
            <input name="date" id="dateInput" maxlength="4" placeholder="0528" required>
          </div>
          <div class="field">
            <label>Frame rate</label>
            <select name="fps">
              <option value="25" selected>25 fps</option>
              <option value="29.97">29.97 fps</option>
              <option value="50">50 fps</option>
              <option value="23.976">23.976 fps</option>
              <option value="24">24 fps</option>
            </select>
          </div>
          <div class="field">
            <label>Log format</label>
            <select name="log">
              <option value="slog3" selected>S-Log3 → 709 (Sony)</option>
              <option value="slog2">S-Log2 → 709 (Sony)</option>
              <option value="dlogm">D-Log M → 709 (DJI)</option>
              <option value="none">None — already Rec.709</option>
            </select>
          </div>
          <div class="field"><!-- spacer --></div>
          <div class="field span2">
            <label>Output root</label>
            <div class="path-row" id="outputWrap">
              <input name="output" id="outputPath" placeholder="D:\\Ingest">
              <button type="button" class="btn" id="browseOutputBtn" onclick="browsePath('outputPath','browseOutputBtn')">Browse…</button>
            </div>
          </div>
          <div class="field">
            <label>Backup drive</label>
            <div class="path-row" id="backupWrap">
              <input name="backup" id="backupPath" placeholder="E:\\SHOW_BACKUP">
              <button type="button" class="btn" id="browseBackupBtn" onclick="browsePath('backupPath','browseBackupBtn')">Browse…</button>
            </div>
            <span class="hint">Originals copied here before transcode</span>
          </div>
          <div class="field">
            <label>AvidMediaFiles path</label>
            <div class="path-row" id="avidWrap">
              <input name="avid" id="avidPath" placeholder="\\\\Server\\AvidMediaFiles\\MXF\\1">
              <button type="button" class="btn" id="browseAvidBtn" onclick="browsePath('avidPath','browseAvidBtn')">Browse…</button>
            </div>
            <span class="hint">Session folder moves here once complete</span>
          </div>
        </div>
        <div class="btn-row">
          <button type="submit" class="btn primary">Set session →</button>
        </div>
      </form>
    </div>
  </div>

  <!-- 2 · Stories -->
  <div class="card" id="c-stories">
    <div class="card-head" onclick="toggleCard('stories')">
      <span class="card-num">2</span>
      <span class="card-title">Stories</span>
      <span class="card-summary" id="cs-stories">0 stories</span>
      <span class="card-chevron">▼</span>
    </div>
    <div class="card-body" id="cb-stories">
      <div class="chips" id="storyChips"><span style="color:var(--m2);font-size:11px">No stories yet</span></div>
      <div style="display:flex;gap:7px;align-items:center">
        <input id="newSlugInput" placeholder="Story slug…" maxlength="20" style="width:160px"
          onkeydown="if(event.key==='Enter'){event.preventDefault();addSlug()}">
        <button class="btn sm" onclick="addSlug()">+ Add</button>
      </div>
    </div>
  </div>

  <!-- 3 · Scan card -->
  <div class="card" id="c-scan">
    <div class="card-head" onclick="toggleCard('scan')">
      <span class="card-num">3</span>
      <span class="card-title">Scan card</span>
      <span class="card-summary" id="cs-scan"></span>
      <span class="card-chevron">▼</span>
    </div>
    <div class="card-body" id="cb-scan">
      <div class="grid">
        <div class="field span2">
          <label>Card path</label>
          <div class="path-row" id="cardPathWrap">
            <input id="cardPath" placeholder="Drop folder here, paste path, or click Browse…">
            <button type="button" class="btn" id="browseCardBtn" onclick="browsePath('cardPath','browseCardBtn')">Browse…</button>
          </div>
        </div>
        <div class="field">
          <label>Camera</label>
          <div class="cam-row" id="camRow">
            ${['A','B','C','D'].map(c =>
              `<button type="button" class="cam-btn" data-cam="${c}" onclick="selCam('${c}')">${c}</button>`
            ).join('')}
          </div>
        </div>
        <div class="field">
          <label>Default story</label>
          <select id="defaultSlug"></select>
        </div>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="scanBtn" onclick="startScan()">Scan card</button>
        <span id="cardNumLabel" style="font-size:11px;color:var(--m)"></span>
      </div>
      <div id="thumbGrid" class="thumbs"></div>
      <div id="addQueueRow" class="btn-row" style="display:none">
        <button class="btn primary" onclick="addToQueue()">Add to ingest queue →</button>
        <button class="btn" onclick="clearScan()">Discard</button>
      </div>
    </div>
  </div>

  <!-- 4 · Queue -->
  <div class="card" id="c-queue">
    <div class="card-head" onclick="toggleCard('queue')">
      <span class="card-num">4</span>
      <span class="card-title">Ingest queue</span>
      <span class="card-summary" id="cs-queue">empty</span>
      <span class="card-chevron">▼</span>
    </div>
    <div class="card-body" id="cb-queue">
      <div class="q-list" id="qList">
        <div class="q-empty">Queue is empty — scan a card and add it above.</div>
      </div>
      <div class="btn-row">
        <button class="btn primary" id="ingestBtn" onclick="startIngest()" disabled>Start ingest →</button>
      </div>
    </div>
  </div>

  <!-- 5 · Progress (always open) -->
  <div class="card" id="c-progress">
    <div class="card-head" onclick="toggleCard('progress')">
      <span class="card-num">5</span>
      <span class="card-title">Progress</span>
      <span class="card-summary" id="cs-progress">idle</span>
      <span class="card-chevron">▼</span>
    </div>
    <div class="card-body" id="cb-progress">
      <div class="prog-status">
        <span class="prog-op" id="progOp">—</span>
        <span class="prog-frac" id="progFrac"></span>
      </div>
      <div class="prog-bar-wrap"><div class="prog-bar" id="progBar"></div></div>
      <div class="log" id="mainLog">
        <div class="log-line"><span class="log-txt info">Waiting for ingest to start…</span></div>
      </div>
      <div id="aleRow" class="ale-row" style="display:none"></div>
    </div>
  </div>

</div>

<!-- Lightbox -->
<div class="lb" id="lb" onclick="this.classList.remove('open')">
  <img id="lbImg" src="" alt="">
  <div class="lb-lbl" id="lbLbl"></div>
</div>

<script>
// ── State ─────────────────────────────────────────────────────────────
let db      = null
let session = null
let curScan = null   // { scanId, clips[], cam, cardNum, cardPath }
let camSel  = 'A'
const queue = []     // { scanId, cardId, cam, cardNum, cardPath, clips[] }
let totalClips = 0
let doneClips  = 0
let opStart    = 0

// ── Init ──────────────────────────────────────────────────────────────
async function init() {
  const res = await fetch('/api/db')
  db = await res.json()
  renderStories()
  const n = new Date()
  document.getElementById('dateInput').value =
    String(n.getMonth()+1).padStart(2,'0') + String(n.getDate()).padStart(2,'0')
  selCam('A')
}

// ── Section toggle ────────────────────────────────────────────────────
function toggleCard(name) {
  const head = document.querySelector('#c-' + name + ' .card-head')
  const body = document.getElementById('cb-' + name)
  const closing = !head.classList.contains('closed')
  head.classList.toggle('closed', closing)
  body.classList.toggle('hidden', closing)
}
function openCard(name) {
  document.querySelector('#c-' + name + ' .card-head').classList.remove('closed')
  document.getElementById('cb-' + name).classList.remove('hidden')
}
function closeCard(name) {
  document.querySelector('#c-' + name + ' .card-head').classList.add('closed')
  document.getElementById('cb-' + name).classList.add('hidden')
}

// ── Stories ───────────────────────────────────────────────────────────
function renderStories() {
  const chips = document.getElementById('storyChips')
  chips.innerHTML = ''
  for (const s of (db?.slugs ?? [])) {
    const el = document.createElement('div')
    el.className = 'chip'
    el.textContent = s.name
    chips.appendChild(el)
  }
  const n = db?.slugs?.length ?? 0
  document.getElementById('cs-stories').textContent = n + ' stor' + (n === 1 ? 'y' : 'ies')
  refreshSlugSelect()
}

function refreshSlugSelect() {
  const sel  = document.getElementById('defaultSlug')
  const prev = sel.value
  sel.innerHTML = ''
  for (const s of (db?.slugs ?? [])) {
    const o = document.createElement('option'); o.value = o.textContent = s.name; sel.appendChild(o)
  }
  if (prev) sel.value = prev
}

async function addSlug() {
  const inp  = document.getElementById('newSlugInput')
  const name = inp.value.trim()
  if (!name) return
  const res = await fetch('/api/slug', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name }),
  })
  db = await res.json()
  inp.value = ''
  renderStories()
}

// ── Session ───────────────────────────────────────────────────────────
document.getElementById('sessionForm').addEventListener('submit', async e => {
  e.preventDefault()
  const data = Object.fromEntries(new FormData(e.target))
  const res  = await fetch('/api/session', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ show: '${SHOW}', ...data }),
  })
  const j  = await res.json()
  session  = j.session
  db       = j.db
  renderStories()
  const label = session.date + ' · ' + session.output_path.replace(/.*[\\\\/]/, '')
  document.getElementById('cs-session').textContent   = label
  document.getElementById('hdrSession').textContent   = 'Session: ' + session.date
  closeCard('session')
  updateCardNum()
})

// ── Camera ────────────────────────────────────────────────────────────
function selCam(c) {
  camSel = c
  document.querySelectorAll('.cam-btn').forEach(b => b.classList.toggle('active', b.dataset.cam === c))
  updateCardNum()
}

function updateCardNum() {
  if (!session) { document.getElementById('cardNumLabel').textContent = ''; return }
  const n = (session.cards ?? []).filter(c => c.cam === camSel).length + 1
  document.getElementById('cardNumLabel').textContent = 'Will be CARD ' + String(n).padStart(3,'0')
}

// ── Path drag-drop ────────────────────────────────────────────────────
function setupDrop(wrapId, inputId) {
  const wrap = document.getElementById(wrapId)
  const inp  = document.getElementById(inputId)
  if (!wrap || !inp) return
  wrap.addEventListener('dragover', e => { e.preventDefault(); inp.classList.add('path-drop-active') })
  wrap.addEventListener('dragleave', e => { if (!wrap.contains(e.relatedTarget)) inp.classList.remove('path-drop-active') })
  wrap.addEventListener('drop', e => {
    e.preventDefault()
    inp.classList.remove('path-drop-active')
    // file:// URI (Finder / Explorer drag)
    const uriList = e.dataTransfer.getData('text/uri-list')
    if (uriList) {
      const line = uriList.split(/[\r\n]+/).find(l => l.startsWith('file://') && !l.startsWith('#'))
      if (line) {
        let p = decodeURIComponent(line.replace('file://', ''))
        if (/^\\/[A-Za-z]:/.test(p)) p = p.slice(1)  // /C:/foo → C:/foo on Windows
        inp.value = p.replace(/[\\/]+$/, '')
        return
      }
    }
    const text = e.dataTransfer.getData('text/plain')
    if (text && text.trim()) inp.value = text.trim()
  })
}
setupDrop('cardPathWrap',  'cardPath')
setupDrop('outputWrap',    'outputPath')
setupDrop('backupWrap',    'backupPath')
setupDrop('avidWrap',      'avidPath')

async function browsePath(inputId, btnId) {
  const btn = btnId ? document.getElementById(btnId) : null
  if (btn) { btn.disabled = true; btn.textContent = '…' }
  try {
    const res = await fetch('/api/browse')
    const { path } = await res.json()
    if (path) document.getElementById(inputId).value = path
  } catch {}
  if (btn) { btn.disabled = false; btn.textContent = 'Browse…' }
}

// ── Scan ──────────────────────────────────────────────────────────────
async function startScan() {
  if (!session) { alert('Set up a session first (section 1).'); return }
  const cardPath    = document.getElementById('cardPath').value.trim()
  const defaultSlug = document.getElementById('defaultSlug').value
  if (!cardPath) { alert('Enter a card path.'); return }

  document.getElementById('scanBtn').disabled = true
  document.getElementById('scanBtn').textContent = 'Scanning…'
  document.getElementById('thumbGrid').innerHTML = ''
  document.getElementById('addQueueRow').style.display = 'none'
  document.getElementById('cs-scan').textContent = 'scanning…'
  curScan = null
  opStart = Date.now()

  const cardNum = (session.cards ?? []).filter(c => c.cam === camSel).length + 1
  logAdd('Scanning ' + cardPath + '…', 'info')

  const res = await fetch('/api/scan', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ sessionId: session.id, inputPath: cardPath, cam: camSel, cardNum, defaultSlug }),
  })
  const { scanId, error } = await res.json()
  if (error) {
    logAdd('Scan error: ' + error, 'err')
    document.getElementById('scanBtn').disabled = false
    document.getElementById('scanBtn').textContent = 'Scan card'
    return
  }

  curScan = { scanId, clips: [], cam: camSel, cardNum, cardPath }
  const es = new EventSource('/api/scan-events/' + scanId)
  es.addEventListener('log',     e => logAdd(e.data, 'info'))
  es.addEventListener('preview', e => {
    const clip = JSON.parse(e.data); curScan.clips.push(clip); addThumb(clip, defaultSlug)
  })
  es.addEventListener('done', () => {
    es.close()
    document.getElementById('scanBtn').disabled = false
    document.getElementById('scanBtn').textContent = 'Scan card'
    const n = curScan.clips.length
    document.getElementById('cs-scan').textContent = n + ' clip' + (n !== 1 ? 's' : '') + ' found'
    if (n > 0) { document.getElementById('addQueueRow').style.display = 'flex' }
    logAdd('Scan complete — ' + n + ' clip(s) found.', 'ok')
  })
  es.addEventListener('error', e => {
    const d = e.data ? JSON.parse(e.data) : {}
    logAdd('Scan error: ' + (d.message ?? 'unknown'), 'err')
    es.close()
    document.getElementById('scanBtn').disabled = false
    document.getElementById('scanBtn').textContent = 'Scan card'
  })
}

function addThumb(clip, defaultSlug) {
  const grid   = document.getElementById('thumbGrid')
  const card   = document.createElement('div'); card.className = 'thumb'; card.id = 'tc_' + clip.name
  const iw     = document.createElement('div'); iw.className = 'thumb-img'

  if (clip.previewPath) {
    const img = document.createElement('img')
    img.src   = '/api/preview?path=' + encodeURIComponent(clip.previewPath)
    img.alt   = clip.name
    img.onclick = () => { document.getElementById('lbImg').src = img.src; document.getElementById('lbLbl').textContent = clip.name; document.getElementById('lb').classList.add('open') }
    iw.appendChild(img)
  } else {
    const ph = document.createElement('div'); ph.className = 'thumb-ph'; ph.textContent = 'no preview'; iw.appendChild(ph)
  }

  const badge = document.createElement('div'); badge.className = 'thumb-badge'
  badge.textContent = clip.codec + ' ' + clip.width + '×' + clip.height; iw.appendChild(badge)

  const foot = document.createElement('div'); foot.className = 'thumb-foot'
  const nm   = document.createElement('div'); nm.className = 'thumb-name'; nm.textContent = clip.originalName; nm.title = clip.name
  const sel  = document.createElement('select')
  for (const s of (db?.slugs ?? [])) {
    const o = document.createElement('option'); o.value = o.textContent = s.name; sel.appendChild(o)
  }
  sel.value = defaultSlug ?? ''
  sel.onchange = () => { const c = curScan.clips.find(x => x.name === clip.name); if (c) c.slug = sel.value }
  foot.appendChild(nm); foot.appendChild(sel)
  card.appendChild(iw); card.appendChild(foot); grid.appendChild(card)
}

function clearScan() {
  curScan = null
  document.getElementById('thumbGrid').innerHTML = ''
  document.getElementById('addQueueRow').style.display = 'none'
  document.getElementById('cs-scan').textContent = ''
}

// ── Queue ─────────────────────────────────────────────────────────────
async function addToQueue() {
  if (!curScan) return
  const res = await fetch('/api/scan-commit', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({
      sessionId: session.id, scanId: curScan.scanId,
      clips: curScan.clips.map(c => ({ name: c.name, slug: c.slug })),
    }),
  })
  const { cardId } = await res.json()
  const r2 = await fetch('/api/session/' + session.id)
  session  = await r2.json()

  queue.push({ ...curScan, cardId })
  renderQueue()
  clearScan()
  updateCardNum()
  openCard('queue')
}

function renderQueue() {
  const list = document.getElementById('qList')
  if (queue.length === 0) {
    list.innerHTML = '<div class="q-empty">Queue is empty — scan a card and add it above.</div>'
    document.getElementById('ingestBtn').disabled = true
    document.getElementById('cs-queue').textContent = 'empty'
    return
  }
  list.innerHTML = ''
  for (const item of queue) {
    const el = document.createElement('div'); el.className = 'q-item'
    const info = document.createElement('div'); info.className = 'q-info'
    const ttl  = document.createElement('div'); ttl.className = 'q-title'
    ttl.textContent = 'CAM ' + item.cam + ' — CARD ' + String(item.cardNum).padStart(3,'0')
    const meta = document.createElement('div'); meta.className = 'q-meta'
    meta.textContent = item.cardPath + ' · ' + item.clips.length + ' clip' + (item.clips.length !== 1 ? 's' : '')
    info.appendChild(ttl); info.appendChild(meta)
    const chip = document.createElement('div'); chip.className = 'q-chip'
    chip.id = 'qc_' + item.scanId
    chip.dataset.cardId = item.cardId || ''
    chip.textContent = 'queued'
    el.appendChild(info); el.appendChild(chip); list.appendChild(el)
  }
  document.getElementById('ingestBtn').disabled = false
  const totalC = queue.reduce((s, i) => s + i.clips.length, 0)
  document.getElementById('cs-queue').textContent =
    queue.length + ' card' + (queue.length !== 1 ? 's' : '') + ' · ' + totalC + ' clips'
}

// ── Ingest ────────────────────────────────────────────────────────────
async function startIngest() {
  if (!session || queue.length === 0) return
  totalClips = queue.reduce((s, i) => s + i.clips.length, 0)
  doneClips  = 0
  opStart    = Date.now()
  document.getElementById('ingestBtn').disabled = true
  openCard('progress')
  setProgress('Starting…', 0)

  const res = await fetch('/api/ingest', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ sessionId: session.id }),
  })
  const { jobId, error } = await res.json()
  if (error) { logAdd('Error: ' + error, 'err'); return }

  const es = new EventSource('/api/ingest-events/' + jobId)

  es.addEventListener('log', e => logAdd(e.data, 'info'))

  es.addEventListener('backup', e => {
    const p = JSON.parse(e.data)
    setQueueChip(p.cardId, 'Backing up…', 'backing')
    setProgress('Backing up originals…', doneClips / totalClips)
  })

  es.addEventListener('transcode', e => {
    const p = JSON.parse(e.data)
    if (p.status === 'started') {
      setThumbBadge(p.clip, 'xcode')
      setQueueChip(p.cardId, (p.index||'?') + ' / ' + (p.total||'?'), 'running')
      setProgress('Transcoding ' + p.clip, doneClips / totalClips)
      logAdd('[' + (p.index||'?') + '/' + (p.total||'?') + '] ' + p.clip, 'xcode')
    }
    if (p.status === 'done') {
      setThumbBadge(p.clip, 'done')
      doneClips++
      setProgress('Transcoding…', doneClips / totalClips)
    }
  })

  es.addEventListener('card-done', e => {
    const p = JSON.parse(e.data)
    setQueueChip(p.cardId, 'done ✓', 'done')
  })

  es.addEventListener('done', e => {
    const result = JSON.parse(e.data)
    es.close()
    setProgress('Complete', 1)
    logAdd('Ingest complete — ' + totalClips + ' clip(s) processed.', 'ok')
    document.getElementById('cs-progress').textContent = 'complete'
    renderAleLinks(result.stories)
  })

  es.addEventListener('error', e => {
    const d = e.data ? JSON.parse(e.data) : {}
    logAdd('Error: ' + (d.message ?? 'unknown'), 'err')
    es.close()
    document.getElementById('ingestBtn').disabled = false
  })
}

// ── Progress helpers ──────────────────────────────────────────────────
function setProgress(op, frac) {
  document.getElementById('progOp').textContent   = op
  document.getElementById('progFrac').textContent = doneClips + ' / ' + totalClips + ' clips'
  document.getElementById('progBar').style.width  = Math.min(100, Math.round(frac * 100)) + '%'
  document.getElementById('cs-progress').textContent = Math.min(100, Math.round(frac * 100)) + '%'
}

function setQueueChip(cardId, text, cls) {
  document.querySelectorAll('.q-chip').forEach(c => {
    if (c.dataset.cardId === cardId) { c.textContent = text; c.className = 'q-chip ' + cls }
  })
}

function setThumbBadge(name, cls) {
  const el = document.getElementById('tc_' + name)
  if (!el) return
  const b = el.querySelector('.thumb-badge')
  if (b) b.className = 'thumb-badge ' + cls
}

// ── Log ───────────────────────────────────────────────────────────────
function logAdd(msg, type) {
  const log = document.getElementById('mainLog')
  // Clear the placeholder on first real message
  if (log.children.length === 1 && log.firstChild?.textContent?.includes('Waiting')) log.innerHTML = ''
  const line = document.createElement('div'); line.className = 'log-line'
  const elapsed = Math.floor((Date.now() - (opStart || Date.now())) / 1000)
  const ts = String(Math.floor(elapsed/60)).padStart(2,'0') + ':' + String(elapsed%60).padStart(2,'0')
  const t  = document.createElement('span'); t.className = 'log-ts'; t.textContent = ts
  const m  = document.createElement('span'); m.className = 'log-txt ' + (type||'info'); m.textContent = msg
  line.appendChild(t); line.appendChild(m); log.appendChild(line)
  log.scrollTop = log.scrollHeight
}

// ── ALE links ─────────────────────────────────────────────────────────
function renderAleLinks(stories) {
  const row = document.getElementById('aleRow')
  row.innerHTML = ''
  for (const { slug, alePath, fcpxmlPath, clipCount } of (stories ?? [])) {
    if (alePath) {
      const a = document.createElement('a'); a.className = 'ale-btn'
      a.href = '/api/download?path=' + encodeURIComponent(alePath)
      a.download = alePath.split(/[\\\\/]/).pop()
      a.textContent = '↓ ' + a.download + ' (' + clipCount + ')'
      row.appendChild(a)
    }
    if (fcpxmlPath) {
      const a = document.createElement('a'); a.className = 'ale-btn'
      a.href = '/api/download?path=' + encodeURIComponent(fcpxmlPath)
      a.download = fcpxmlPath.split(/[\\\\/]/).pop()
      a.textContent = '↓ ' + a.download
      row.appendChild(a)
    }
  }
  if (row.children.length) row.style.display = 'flex'
}

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
    const slugs = await getSlugs(show.id)
    json({ slugs })
    return
  }

  // Add slug
  if (req.method === 'POST' && url.pathname === '/api/slug') {
    const { name } = await body()
    await addSlug(show.id, name)
    const slugs = await getSlugs(show.id)
    json({ slugs })
    return
  }

  // Create/get session
  if (req.method === 'POST' && url.pathname === '/api/session') {
    const params  = await body()
    const today   = new Date()
    const date    = params.date || (String(today.getMonth()+1).padStart(2,'0') + String(today.getDate()).padStart(2,'0'))
    const session = await getOrCreateSession(show.id, {
      date,
      outputPath: params.output,
      backupPath: params.backup ?? null,
      avidPath:   params.avid   ?? null,
      logPreset:  params.log    ?? 'none',
      fps:        params.fps    ?? '25',
    })
    const slugs = await getSlugs(show.id)
    json({ session, db: { slugs } })
    return
  }

  // Get session with cards
  if (req.method === 'GET' && url.pathname.startsWith('/api/session/')) {
    const sessionId = url.pathname.split('/api/session/')[1]
    const session   = await getSessionWithCards(sessionId)
    if (!session) { json({ error: 'Session not found' }, 404); return }
    json(session)
    return
  }

  // Native folder picker
  if (req.method === 'GET' && url.pathname === '/api/browse') {
    try {
      let path = null
      if (process.platform === 'darwin') {
        path = execSync(
          "osascript -e 'POSIX path of (choose folder with prompt \"Select folder\")'",
          { timeout: 60000 }
        ).toString().trim().replace(/\/$/, '')
      } else if (process.platform === 'win32') {
        const r = spawnSync('powershell', [
          '-NoProfile', '-Command',
          "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = 'Select folder'; $d.RootFolder = 'MyComputer'; $null = $d.ShowDialog(); $d.SelectedPath",
        ], { timeout: 60000, encoding: 'utf8' })
        path = r.stdout?.trim() || null
      }
      json({ path: path || null })
    } catch {
      json({ path: null })
    }
    return
  }

  // Scan a card
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    const params  = await body()
    const session = await getSession(params.sessionId)
    if (!session) { json({ error: 'Session not found' }, 404); return }

    const scanId = randomUUID()
    const jobId  = createJob()
    scans.set(scanId, { jobId, clips: [], params })
    json({ scanId })

    scanCard(
      {
        inputPath: params.inputPath,
        cam:       params.cam,
        cardNum:   params.cardNum,
        date:      session.date,
        slug:      params.defaultSlug,
        output:    session.output_path,
        log:       session.log_preset,
        fps:       session.fps,
      },
      event => {
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
    for (const ev of job.events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`)
    if (!job.clients.includes(res)) job.clients.push(res)
    req.on('close', () => { job.clients = job.clients.filter(c => c !== res) })
    return
  }

  // Commit scan → add card + clips to DB
  if (req.method === 'POST' && url.pathname === '/api/scan-commit') {
    const { sessionId, scanId, clips: assignments } = await body()
    const scan = scans.get(scanId)
    if (!scan) { json({ error: 'Scan not found' }, 404); return }

    for (const clip of scan.clips) {
      const assign = assignments.find(a => a.name === clip.name)
      if (assign) clip.slug = assign.slug
    }

    const cardNum = await nextCardNum(sessionId, scan.params.cam)
    const card    = await addCard(sessionId, {
      inputPath: scan.params.inputPath,
      cam:       scan.params.cam,
      cardNum,
    })

    const slugs = await getSlugs(show.id)
    for (const clip of scan.clips) {
      const slugRow = slugs.find(s => s.name === clip.slug)
      await addClip(card.id, { ...clip, slugId: slugRow?.id ?? null })
    }

    const session = await getSession(sessionId)
    if (session) {
      const relays = await detectRelays(sessionId, session.fps ?? '25')
      if (relays.length > 0) console.log(`[relay] ${relays.length} span(s) detected`)
    }

    json({ ok: true, cardId: card.id })
    return
  }

  // Start ingest
  if (req.method === 'POST' && url.pathname === '/api/ingest') {
    const { sessionId } = await body()
    const session       = await getSessionWithCards(sessionId)
    if (!session) { json({ error: 'Session not found' }, 404); return }

    const jobId = createJob()
    json({ jobId })

    ;(async () => {
      const emit = (type, data) => emitToJob(jobId, type, data)

      await detectRelays(sessionId, session.fps ?? '25')

      // Build relay group map
      const allClips = session.cards.flatMap(card =>
        card.clips.map(clip => ({ ...clip, cardData: card }))
      )
      const relayGroupMap = {}
      for (const clip of allClips) {
        if (clip.relay_group) {
          ;(relayGroupMap[clip.relay_group] = relayGroupMap[clip.relay_group] ?? []).push(clip)
        }
      }
      for (const parts of Object.values(relayGroupMap)) {
        parts.sort((a, b) => (a.relay_part ?? 1) - (b.relay_part ?? 1))
      }

      const transcodeOpts = {
        date:   session.date,
        output: session.output_path,
        log:    session.log_preset,
        fps:    session.fps ?? '25',
      }

      for (const card of session.cards) {
        if (card.status === 'complete') continue
        await updateCardStatus(card.id, 'ingesting')

        // 1. Backup
        emit('backup', { cardId: card.id })
        try {
          await backupCard(
            { card, date: session.date, backupRoot: session.backup_path },
            ev => emit(ev.type, ev.data)
          )
        } catch (e) {
          emit('log', `Backup warning: ${e.message}`)
        }

        // 2. Transcode
        let index = 0
        for (const clip of card.clips) {
          index++

          if ((clip.relay_part ?? 0) > 1) {
            emit('log', `[${clip.name}] relay part ${clip.relay_part} — merged into part 1 proxy`)
            continue
          }

          emit('transcode', { cardId: card.id, clip: clip.name, index, total: card.clips.length, status: 'started' })

          try {
            if (clip.relay_group && clip.relay_part === 1) {
              const parts = relayGroupMap[clip.relay_group] ?? [clip]
              await transcodeRelayGroup(
                { parts, ...transcodeOpts },
                ev => emit(ev.type, { ...ev.data, cardId: card.id })
              )
            } else {
              await transcodeCard(
                { card: { ...card, clips: [clip] }, ...transcodeOpts },
                ev => emit(ev.type, { ...ev.data, cardId: card.id })
              )
            }
            emit('transcode', { cardId: card.id, clip: clip.name, index, total: card.clips.length, status: 'done' })
          } catch (e) {
            emit('log', `Error on ${clip.name}: ${e.message}`)
          }
        }

        await updateCardStatus(card.id, 'complete')
        emit('card-done', { cardId: card.id })
      }

      // Move session staging folder into AvidMediaFiles
      if (session.avid_path) {
        const stagingDir = join(session.output_path, '_staging', session.date)
        commitSessionToAvid(
          { stagingDir, avidRoot: session.avid_path, sessionFolder: `${SHOW}_${session.date}` },
          ev => emit(ev.type, ev.data)
        )
      }

      // Relay manifest
      const allRelayGroups = Object.values(relayGroupMap).filter(p => p.length > 1)
      if (allRelayGroups.length > 0) {
        const manifest = {
          session: sessionId, date: session.date,
          relays: allRelayGroups.map(parts => ({
            relay_group: parts[0].relay_group,
            parts: parts.map(p => ({
              relay_part: p.relay_part, clip_name: p.name,
              file_path: p.file_path, start_tc: p.start_tc, end_tc: p.end_tc,
              card: p.cardData?.card_num ?? p.card_num,
            })),
          })),
        }
        mkdirSync(session.output_path, { recursive: true })
        writeFileSync(join(session.output_path, 'session-relays.json'), JSON.stringify(manifest, null, 2), 'utf8')
        emit('log', `Relay manifest written (${allRelayGroups.length} group(s))`)
      }

      // Build per-story ALEs + FCPXML
      const storyMap = await clipsBySlug(sessionId)
      const stories  = []
      mkdirSync(session.output_path, { recursive: true })

      for (const [slug, clips] of Object.entries(storyMap)) {
        const aleContent    = buildALE(clips, session.fps, slug, session.date)
        const fcpxmlContent = buildFCPXML(clips, session.fps, slug, session.date, session.output_path)
        const alePath       = join(session.output_path, `${session.date}_${slug}.ale`)
        const fcpxmlPath    = join(session.output_path, `${session.date}_${slug}.fcpxml`)
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

async function autoUpdate() {
  try {
    execSync('git fetch --quiet', { cwd: dirname(fileURLToPath(import.meta.url)), stdio: 'ignore', timeout: 5000 })
    const behind = execSync('git rev-list HEAD..@{u} --count', { cwd: dirname(fileURLToPath(import.meta.url)), stdio: 'pipe', timeout: 5000 }).toString().trim()
    if (parseInt(behind) > 0) {
      execSync('git pull --ff-only --quiet', { cwd: dirname(fileURLToPath(import.meta.url)), stdio: 'pipe', timeout: 15000 })
      console.log(`[postie] Updated (${behind} commit(s) pulled) — restart if behaviour changes\n`)
    }
  } catch { /* offline or not a git repo — ignore */ }
}

server.listen(PORT, '0.0.0.0', async () => {
  await autoUpdate()
  show = await getShow(SHOW)
  if (!show) {
    console.error(`Show '${SHOW}' not found in database. Add it to the shows table first.`)
    process.exit(1)
  }
  console.log(`\nPostie Rushes — ${show.name ?? SHOW}\nhttp://localhost:${PORT}\n`)
})
