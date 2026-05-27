'use client'

import { useState, use } from 'react'
import { getShow } from '@/config/shows'

const CONTENT_TYPES = [
  {
    id: 'EDIT',
    label: 'Edit',
    subtypes: ['ROUGH', 'FINE', 'PICTURE_LOCK', 'ARCHIVE'],
  },
  {
    id: 'ONLINE',
    label: 'Online / Grade',
    subtypes: ['GRADE', 'ONLINE', 'CONFORM', 'DCP'],
  },
  {
    id: 'AUDIO',
    label: 'Audio',
    subtypes: ['DIALOGUE', 'MUSIC', 'SFX', 'MIX', 'ATMOS', 'STEMS'],
  },
  {
    id: 'GFX',
    label: 'Graphics',
    subtypes: ['TITLES', 'LOWER_THIRDS', 'ENDBOARD', 'MOTION', 'STILL'],
  },
  {
    id: 'DELIVERY',
    label: 'Delivery',
    subtypes: ['TX', 'STREAMING', 'SCREENER', 'PROMO'],
  },
  {
    id: 'RUSHES',
    label: 'Rushes',
    subtypes: ['RAW', 'PROXY', 'TRANSCODE'],
  },
]

function formatDate(d: Date) {
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

function pad(n: string, len = 2) {
  return n.padStart(len, '0')
}

export default function FilenameGeneratorPage({
  params,
}: {
  params: Promise<{ show: string }>
}) {
  const { show } = use(params)
  const showConfig = getShow(show)

  const [season, setSeason] = useState('1')
  const [episode, setEpisode] = useState('1')
  const [contentType, setContentType] = useState(CONTENT_TYPES[0])
  const [subtype, setSubtype] = useState(CONTENT_TYPES[0].subtypes[0])
  const [version, setVersion] = useState('1')
  const [includeDate, setIncludeDate] = useState(true)
  const [copied, setCopied] = useState(false)

  const code = showConfig?.code ?? show.toUpperCase()
  const parts = [
    code,
    `S${pad(season)}E${pad(episode)}`,
    contentType.id,
    subtype,
    `v${version}`,
    ...(includeDate ? [formatDate(new Date())] : []),
  ]
  const filename = parts.join('_')

  function copy() {
    navigator.clipboard.writeText(filename)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  function handleContentTypeChange(id: string) {
    const ct = CONTENT_TYPES.find((c) => c.id === id)!
    setContentType(ct)
    setSubtype(ct.subtypes[0])
  }

  return (
    <main className="min-h-screen px-6 py-16 max-w-2xl mx-auto">
      <div className="mb-10">
        <a
          href={`/${show}`}
          className="text-xs mb-6 block"
          style={{ color: 'var(--text-muted)' }}
        >
          ← {code}
        </a>
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          Filename Generator
        </h1>
      </div>

      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Season">
            <NumberInput value={season} onChange={setSeason} min={1} max={99} />
          </Field>
          <Field label="Episode">
            <NumberInput value={episode} onChange={setEpisode} min={1} max={999} />
          </Field>
        </div>

        <Field label="Content type">
          <Select
            value={contentType.id}
            onChange={handleContentTypeChange}
            options={CONTENT_TYPES.map((c) => ({ value: c.id, label: c.label }))}
          />
        </Field>

        <Field label="Subtype">
          <Select
            value={subtype}
            onChange={setSubtype}
            options={contentType.subtypes.map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
          />
        </Field>

        <Field label="Version">
          <NumberInput value={version} onChange={setVersion} min={1} max={99} />
        </Field>

        <label className="flex items-center gap-3 cursor-pointer select-none">
          <div
            onClick={() => setIncludeDate(!includeDate)}
            className="w-9 h-5 rounded-full relative transition-colors cursor-pointer"
            style={{ background: includeDate ? '#4ade80' : 'var(--surface-2)' }}
          >
            <div
              className="absolute top-0.5 w-4 h-4 rounded-full transition-transform"
              style={{
                background: 'white',
                transform: includeDate ? 'translateX(18px)' : 'translateX(2px)',
              }}
            />
          </div>
          <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Include date
          </span>
        </label>
      </div>

      <div
        className="mt-10 rounded-lg border px-5 py-5 flex items-center justify-between gap-4"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <span className="font-mono text-sm break-all" style={{ color: 'var(--text)' }}>
          {filename}
        </span>
        <button
          onClick={copy}
          className="shrink-0 text-xs px-3 py-1.5 rounded transition-colors font-medium"
          style={{
            background: copied ? '#4ade8022' : 'var(--surface-2)',
            color: copied ? '#4ade80' : 'var(--text)',
            border: '1px solid var(--border)',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </main>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {label}
      </label>
      {children}
    </div>
  )
}

function NumberInput({
  value,
  onChange,
  min,
  max,
}: {
  value: string
  onChange: (v: string) => void
  min: number
  max: number
}) {
  return (
    <div className="flex items-center rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border)' }}>
      <button
        className="px-3 py-2.5 text-sm transition-colors"
        style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
        onClick={() => onChange(String(Math.max(min, parseInt(value) - 1)))}
      >
        −
      </button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 text-center text-sm py-2.5 outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
        style={{ background: 'var(--surface)', color: 'var(--text)' }}
      />
      <button
        className="px-3 py-2.5 text-sm transition-colors"
        style={{ background: 'var(--surface-2)', color: 'var(--text-muted)' }}
        onClick={() => onChange(String(Math.min(max, parseInt(value) + 1)))}
      >
        +
      </button>
    </div>
  )
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-lg border px-4 py-2.5 text-sm outline-none appearance-none cursor-pointer"
      style={{
        background: 'var(--surface)',
        borderColor: 'var(--border)',
        color: 'var(--text)',
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
