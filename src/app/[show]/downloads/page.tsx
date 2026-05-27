import { getShow } from '@/config/shows'
import { notFound } from 'next/navigation'

// Add downloads here — files should be placed in /public/downloads/[show]/
const DOWNLOADS: Record<string, { name: string; filename: string; description: string; category: string }[]> = {
  pghi: [
    // { name: 'Show LUT', filename: 'PGHI_Show_LUT.cube', description: 'Primary grade LUT', category: 'Grade' },
  ],
}

export default async function DownloadsPage({ params }: { params: Promise<{ show: string }> }) {
  const { show } = await params
  const showConfig = getShow(show)
  if (!showConfig) notFound()

  const files = DOWNLOADS[show] ?? []

  return (
    <main className="min-h-screen px-6 py-16 max-w-2xl mx-auto">
      <a href={`/${show}`} className="text-xs mb-6 block" style={{ color: 'var(--text-muted)' }}>
        ← {showConfig.code}
      </a>
      <h1 className="text-lg font-semibold mb-10" style={{ color: 'var(--text)' }}>
        Downloads
      </h1>

      {files.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No files yet.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {files.map((file) => (
            <a
              key={file.filename}
              href={`/downloads/${show}/${file.filename}`}
              download
              className="flex items-center justify-between rounded-lg border px-5 py-4 transition-colors"
              style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
            >
              <div>
                <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                  {file.name}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                  {file.description} · {file.category}
                </p>
              </div>
              <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                ↓
              </span>
            </a>
          ))}
        </div>
      )}
    </main>
  )
}
