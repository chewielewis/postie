export type ToolStatus = 'live' | 'coming-soon'

export type Tool = {
  id: string
  name: string
  description: string
  status: ToolStatus
}

export type Show = {
  slug: string
  name: string
  code: string
  description: string
  accentColor: string
  tools: Tool[]
}

export const shows: Show[] = [
  {
    slug: 'pghi',
    name: 'Paddy Gower Has Issues',
    code: 'PGHI',
    description: 'Post production tools for Paddy Gower Has Issues',
    accentColor: '#E63946',
    tools: [
      {
        id: 'filename-generator',
        name: 'Filename Generator',
        description: 'Generate consistent filenames for edits and deliverables',
        status: 'live',
      },
      {
        id: 'rushes',
        name: 'Rushes Processor',
        description: 'Scan a drive, generate DNxHR proxies, export ALE and Resolve XML',
        status: 'live',
      },
      {
        id: 'downloads',
        name: 'Downloads',
        description: 'Templates, LUTs, titles, and show assets',
        status: 'live',
      },
      {
        id: 'uploads',
        name: 'Uploads',
        description: 'Drop files for the team to pick up',
        status: 'coming-soon',
      },
      {
        id: 'rundown',
        name: 'Rundown',
        description: 'Episode tracker and cut versions',
        status: 'coming-soon',
      },
      {
        id: 'deliverables',
        name: 'Deliverables',
        description: 'Track deliverable status per episode',
        status: 'coming-soon',
      },
      {
        id: 'timecode-notes',
        name: 'Timecode Notes',
        description: 'Notes pinned to specific timecodes',
        status: 'coming-soon',
      },
    ],
  },
]

export function getShow(slug: string): Show | undefined {
  return shows.find((s) => s.slug === slug)
}
