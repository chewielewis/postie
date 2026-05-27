import Link from 'next/link'
import { shows } from '@/config/shows'

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center px-6 py-24">
      <div className="w-full max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight mb-1" style={{ color: 'var(--text)' }}>
          Postie
        </h1>
        <p className="text-sm mb-12" style={{ color: 'var(--text-muted)' }}>
          Post production tools
        </p>

        <div className="flex flex-col gap-3">
          {shows.map((show) => (
            <Link
              key={show.slug}
              href={`/${show.slug}`}
              className="group flex items-center justify-between rounded-lg border px-5 py-4 transition-colors"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface)',
              }}
            >
              <div>
                <div className="flex items-center gap-3 mb-1">
                  <span
                    className="text-xs font-mono font-semibold px-1.5 py-0.5 rounded"
                    style={{ background: show.accentColor + '22', color: show.accentColor }}
                  >
                    {show.code}
                  </span>
                  <span className="font-medium text-sm" style={{ color: 'var(--text)' }}>
                    {show.name}
                  </span>
                </div>
                <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  {show.tools.filter((t) => t.status === 'live').length} tools available
                </p>
              </div>
              <span className="text-lg" style={{ color: 'var(--text-muted)' }}>→</span>
            </Link>
          ))}
        </div>
      </div>
    </main>
  )
}
