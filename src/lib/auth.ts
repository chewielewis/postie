import { cookies } from 'next/headers'

const PASSWORDS: Record<string, string> = {
  pghi: process.env.PGHI_PASSWORD ?? 'pghi2024',
}

export function getShowPassword(slug: string): string | undefined {
  return PASSWORDS[slug]
}

export async function isAuthenticated(slug: string): Promise<boolean> {
  const jar = await cookies()
  const token = jar.get(`postie_auth_${slug}`)?.value
  const expected = getShowPassword(slug)
  if (!expected) return false
  return token === expected
}
