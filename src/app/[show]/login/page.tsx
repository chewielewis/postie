'use client'

import { useState, use } from 'react'
import { useRouter } from 'next/navigation'

export default function LoginPage({ params }: { params: Promise<{ show: string }> }) {
  const { show } = use(params)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const res = await fetch(`/api/auth/${show}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    })

    if (res.ok) {
      router.push(`/${show}`)
      router.refresh()
    } else {
      setError('Wrong password')
      setLoading(false)
    }
  }

  return (
    <main className="min-h-screen flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <p className="text-xs font-mono mb-8 uppercase tracking-widest" style={{ color: 'var(--text-muted)' }}>
          {show.toUpperCase()}
        </p>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            className="w-full rounded-lg border px-4 py-3 text-sm outline-none focus:border-white/30 transition-colors"
            style={{
              background: 'var(--surface)',
              borderColor: 'var(--border)',
              color: 'var(--text)',
            }}
          />
          {error && (
            <p className="text-xs" style={{ color: '#E63946' }}>{error}</p>
          )}
          <button
            type="submit"
            disabled={loading || !password}
            className="w-full rounded-lg py-3 text-sm font-medium transition-opacity disabled:opacity-40"
            style={{ background: 'var(--surface-2)', color: 'var(--text)' }}
          >
            {loading ? 'Checking…' : 'Enter'}
          </button>
        </form>
      </div>
    </main>
  )
}
