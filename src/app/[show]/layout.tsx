import { redirect } from 'next/navigation'
import { isAuthenticated } from '@/lib/auth'
import { getShow } from '@/config/shows'
import { notFound } from 'next/navigation'

export default async function ShowLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ show: string }>
}) {
  const { show } = await params
  const showConfig = getShow(show)
  if (!showConfig) notFound()

  const authed = await isAuthenticated(show)
  if (!authed) redirect(`/${show}/login`)

  return <>{children}</>
}
