import { getShow } from '@/config/shows'
import { notFound } from 'next/navigation'

export default async function RushesPage({ params }: { params: Promise<{ show: string }> }) {
  const { show } = await params
  const showConfig = getShow(show)
  if (!showConfig) notFound()

  return (
    <main className="min-h-screen px-6 py-16 max-w-2xl mx-auto">
      <a href={`/${show}`} className="text-xs mb-6 block" style={{ color: 'var(--text-muted)' }}>
        ← {showConfig.code}
      </a>
      <h1 className="text-lg font-semibold mb-2" style={{ color: 'var(--text)' }}>
        Rushes Processor
      </h1>
      <p className="text-sm mb-10" style={{ color: 'var(--text-muted)' }}>
        A local CLI tool. Runs on your machine — requires Node.js and FFmpeg.
      </p>

      <div className="flex flex-col gap-6">
        <Section title="What it does">
          <ul className="flex flex-col gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <li>→ Scans a card for Sony XAVC/MXF and GoPro/DJI MP4s</li>
            <li>→ Applies naming convention: <code className="font-mono text-xs" style={{ color: 'var(--text)' }}>MMDD_SLUG_CAM&lt;X&gt;_ClipName</code></li>
            <li>→ Sets TapeID = clip name — <strong style={{ color: 'var(--text)' }}>no Avid Bulk Edit needed</strong></li>
            <li>→ Transcodes to DNxHR LB MXF proxies via FFmpeg</li>
            <li>→ Outputs an <strong style={{ color: 'var(--text)' }}>ALE</strong> for Avid and <strong style={{ color: 'var(--text)' }}>FCPXML</strong> for Resolve with identical metadata</li>
          </ul>
        </Section>

        <Section title="Output structure">
          <div className="rounded border px-4 py-3 font-mono text-xs leading-6" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
            {'Ingest/'}<br/>
            {'  0524_CLIMATE/'}<br/>
            {'    CAM A/'}<br/>
            {'      proxies/   ← DNxHR LB MXF'}<br/>
            {'  0524_CLIMATE_CAMA.ale'}<br/>
            {'  0524_CLIMATE_CAMA.fcpxml'}
          </div>
        </Section>

        <Section title="Requirements">
          <ul className="flex flex-col gap-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            <li>Node.js 18+</li>
            <li>FFmpeg with DNxHR support</li>
          </ul>
          <div className="mt-3 rounded border px-4 py-3 font-mono text-xs" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
            brew install node ffmpeg
          </div>
        </Section>

        <Section title="Install">
          <a
            href="/downloads/postie-rushes.mjs"
            download
            className="inline-flex items-center gap-2 text-xs rounded border px-3 py-2 transition-colors"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          >
            ↓ postie-rushes.mjs
          </a>
          <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
            Save anywhere on the ingest machine. Requires Node.js 18+ and FFmpeg.
          </p>
        </Section>

        <Section title="UI mode (recommended)">
          <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>
            Opens a browser-based interface on the ingest machine. No terminal knowledge needed.
          </p>
          <div className="rounded border px-4 py-3 font-mono text-xs" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
            node postie-rushes.mjs --ui
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Then open <code className="font-mono">http://localhost:4321</code> — fill in slug, cam, paths → Start. Progress updates live, ALE and FCPXML download when done.
          </p>
        </Section>

        <Section title="Headless mode">
          <div className="rounded border px-4 py-3 font-mono text-xs leading-6" style={{ borderColor: 'var(--border)', background: 'var(--surface-2)', color: 'var(--text-muted)' }}>
            <span style={{ color: 'var(--text)' }}>node postie-rushes.mjs</span>{' \\'}<br/>
            {'  --show '}{showConfig.code}{' \\'}<br/>
            {'  --slug CLIMATE --cam A \\'}<br/>
            {'  --input /Volumes/CARD_001 \\'}<br/>
            {'  --output /Volumes/AvidServer/Ingest'}
          </div>
          <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>
            Add <code className="font-mono">--lut /path/to/show.cube</code> to burn a LUT into proxies.
          </p>
        </Section>
      </div>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs font-medium mb-3 uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        {title}
      </p>
      {children}
    </div>
  )
}
