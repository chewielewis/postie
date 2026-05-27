import Link from 'next/link'
import { getShow } from '@/config/shows'
import { notFound } from 'next/navigation'

export default async function ShowPage({ params }: { params: Promise<{ show: string }> }) {
  const { show } = await params
  const showConfig = getShow(show)
  if (!showConfig) notFound()

  return (
    <main className="min-h-screen px-6 py-16 max-w-3xl mx-auto">
      <div className="mb-12">
        <div className="flex items-center gap-3 mb-2">
          <span
            className="text-xs font-mono font-semibold px-1.5 py-0.5 rounded"
            style={{ background: showConfig.accentColor + '22', color: showConfig.accentColor }}
          >
            {showConfig.code}
          </span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight" style={{ color: 'var(--text)' }}>
          {showConfig.name}
        </h1>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {showConfig.tools.map((tool) => {
          const isLive = tool.status === 'live'
          const card = (
            <div
              key={tool.id}
              className="rounded-lg border px-5 py-4 transition-colors"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface)',
                opacity: isLive ? 1 : 0.45,
              }}
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  {tool.name}
                </p>
                {!isLive && (
                  <span
                    className="text-xs shrink-0"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    soon
                  </span>
                )}
              </div>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                {tool.description}
              </p>
            </div>
          )

          return isLive ? (
            <Link key={tool.id} href={`/${show}/${tool.id}`} className="block group">
              {card}
            </Link>
          ) : (
            <div key={tool.id}>{card}</div>
          )
        })}
      </div>
    </main>
  )
}
