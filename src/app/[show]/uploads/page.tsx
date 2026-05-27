import { getShow } from '@/config/shows'
import { notFound } from 'next/navigation'

export default async function UploadsPage({ params }: { params: Promise<{ show: string }> }) {
  const { show } = await params
  const showConfig = getShow(show)
  if (!showConfig) notFound()

  return (
    <main className="min-h-screen px-6 py-16 max-w-2xl mx-auto">
      <a href={`/${show}`} className="text-xs mb-6 block" style={{ color: 'var(--text-muted)' }}>
        ← {showConfig.code}
      </a>
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Coming soon.</p>
    </main>
  )
}
