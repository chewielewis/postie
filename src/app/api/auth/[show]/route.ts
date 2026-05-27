import { NextRequest, NextResponse } from 'next/server'
import { getShowPassword } from '@/lib/auth'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ show: string }> }
) {
  const { show } = await params
  const { password } = await request.json()
  const expected = getShowPassword(show)

  if (!expected || password !== expected) {
    return NextResponse.json({ error: 'Wrong password' }, { status: 401 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set(`postie_auth_${show}`, password, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 24 * 30,
    path: `/${show}`,
  })
  return response
}
