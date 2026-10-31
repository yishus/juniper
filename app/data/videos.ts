import { parseDocument } from 'htmlparser2'
import { textContent } from 'domutils'
import { ImportError, fetchPublic, readLimited, type Fetcher } from './network.ts'
import type { TranscriptCue } from './types.ts'
import { maxVideoTime, parseVideoTime, videoTime, youtubeVideo } from '../actions/public/youtube.ts'

function plain(value: string): string {
  return textContent(parseDocument(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''))).trim()
}

export function validateTranscript(cues: TranscriptCue[], duration: number | null = null): TranscriptCue[] {
  if (!cues.length || cues.length > 10000 || cues.reduce((sum, cue) => sum + cue.text.length, 0) > 500000) throw new ImportError('Use a transcript with 1–10,000 cues and up to 500,000 text characters.')
  let previous = -1
  for (const cue of cues) {
    if (!Number.isSafeInteger(cue.start) || !Number.isSafeInteger(cue.end) || cue.start < previous || cue.start < 0 || cue.end <= cue.start ||
        cue.end > (duration ?? maxVideoTime) || !cue.text.trim() || cue.text.length > 10000) throw new ImportError('The transcript contains an invalid time range or text. Check the subtitle file.')
    previous = cue.start
  }
  return cues
}

export function parseTranscript(input: string, duration: number | null = null): TranscriptCue[] {
  if (input.length > 1000000) throw new ImportError('Keep the subtitle file under 1,000,000 characters.')
  const cues: TranscriptCue[] = []
  for (const block of input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/)) {
    const lines = block.split('\n')
    if (/^(?:WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue
    const index = lines.findIndex(line => line.includes('-->'))
    if (index < 0) throw new ImportError('Paste timed subtitles in WebVTT or SRT format.')
    const times = /^(\S+)\s+-->\s+(\S+)/.exec(lines[index])
    if (!times) throw new ImportError('The subtitle timestamps could not be read.')
    cues.push({ start: parseVideoTime(times[1].replace(',', '.')), end: parseVideoTime(times[2].replace(',', '.')), text: plain(lines.slice(index + 1).join('\n')) })
  }
  return validateTranscript(cues, duration)
}

// Public watch pages sometimes include caption tracks. This is best effort:
// playback and manual highlights work even when YouTube withholds captions.
interface PublicPlayerResponse {
  videoDetails?: { lengthSeconds?: unknown }
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl?: unknown; languageCode?: unknown }[] } }
}
function playerResponse(html: string): PublicPlayerResponse | null {
  const match = /(?:var\s+)?ytInitialPlayerResponse\s*=\s*/.exec(html)
  if (!match) return null
  const start = match.index + match[0].length
  let depth = 0, quoted = false, escaped = false
  for (let index = start; index < html.length; index++) {
    const char = html[index]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
    } else if (char === '"') quoted = true
    else if (char === '{') depth++
    else if (char === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, index + 1)) } catch { return null }
    }
  }
  return null
}

export async function captureVideo(input: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  const video = youtubeVideo(input)
  if (!video) throw new ImportError('Enter a YouTube video URL.')
  const endpoint = new URL('https://www.youtube.com/oembed')
  endpoint.search = new URLSearchParams({ url: video.url, format: 'json' }).toString()
  let metadata: { title?: unknown; author_name?: unknown }
  try {
    const { response } = await fetchPublic(endpoint.href, fetcher, signal)
    metadata = JSON.parse(new TextDecoder().decode(await readLimited(response, 128000)))
    if (!metadata || typeof metadata.title !== 'string' || !metadata.title.trim()) throw new Error('No title')
  } catch {
    throw new ImportError('This YouTube video could not be loaded. Check that the link is public and try again.')
  }
  let duration: number | null = null
  let transcript: TranscriptCue[] = []
  try {
    const captionSignal = AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])])
    const { response } = await fetchPublic(video.url, fetcher, captionSignal)
    const player = playerResponse(new TextDecoder().decode(await readLimited(response, 3 * 1024 * 1024)))
    const length = Number(player?.videoDetails?.lengthSeconds) * 1000
    if (Number.isSafeInteger(length) && length > 0 && length <= maxVideoTime) duration = length
    const tracks: { baseUrl?: unknown; languageCode?: unknown }[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
    const track = Array.isArray(tracks) ? tracks.find(track => track.languageCode === 'en') ?? tracks[0] : undefined
    if (typeof track?.baseUrl === 'string') {
      const url = new URL(track.baseUrl)
      if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.pathname !== '/api/timedtext') throw new Error('Invalid caption URL')
      url.searchParams.set('fmt', 'json3')
      const { response: captions } = await fetchPublic(url.href, fetcher, captionSignal)
      const data = JSON.parse(new TextDecoder().decode(await readLimited(captions, 2 * 1024 * 1024))) as { events?: { tStartMs: number; dDurationMs: number; segs?: { utf8?: string }[] }[] }
      transcript = validateTranscript((data.events ?? []).filter(event => event.segs?.some(seg => seg.utf8?.trim())).map(event => ({
        start: event.tStartMs, end: event.tStartMs + event.dDurationMs, text: event.segs!.map(seg => seg.utf8 ?? '').join('').trim(),
      })), duration)
    }
  } catch { transcript = [] }
  if (signal?.aborted) throw new ImportError('The import was cancelled. Please try again.')
  return { ...video, title: (metadata.title as string).slice(0, 500), author: typeof metadata.author_name === 'string' ? metadata.author_name.slice(0, 200) : null, duration, transcript }
}

export function videoMarkdown(title: string, url: string, cues: TranscriptCue[]): string {
  const escape = (value: string) => value.replace(/[\\`*_[\]<>#~|]/g, '\\$&')
  return `# ${escape(title)}\n\nSource: ${url}\n\n${cues.map(cue => `[${videoTime(cue.start)}](${url}&t=${Math.floor(cue.start / 1000)}) ${escape(cue.text)}`).join('\n\n')}\n`
}
