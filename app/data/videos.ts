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

interface PlayerResponse {
  videoDetails?: { lengthSeconds?: unknown }
  playabilityStatus?: { status?: string; reason?: string }
  captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { baseUrl?: unknown; languageCode?: unknown }[] } }
}

class TranscriptBlockedError extends ImportError {
  constructor() { super('YouTube is blocking transcript requests from Juniper’s server. Try again later or import subtitles downloaded locally.') }
}

export async function fetchVideoTranscript(input: string, fetcher: Fetcher = fetch, signal?: AbortSignal) {
  const video = youtubeVideo(input)
  if (!video) throw new ImportError('Enter a YouTube video URL.')
  const deadline = AbortSignal.any([AbortSignal.timeout(12000), ...(signal ? [signal] : [])])
  try {
    const { response: watch } = await fetchPublic(video.url, fetcher, deadline)
    const html = new TextDecoder().decode(await readLimited(watch, 3 * 1024 * 1024))
    const key = /"INNERTUBE_API_KEY"\s*:\s*"([a-zA-Z0-9_-]+)"/.exec(html)?.[1]
    if (!key) throw new Error('No player API key')

    // Web caption URLs can require a browser-generated PO token. Ask the
    // Android player for its caption tracks instead. This unofficial API can fail.
    // The POST destination is fixed; never follow a redirect with its body.
    const response = await fetcher(`https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(key)}`, {
      method: 'POST', redirect: 'manual', signal: deadline,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } }, videoId: video.videoId }),
    })
    if (!response.ok) { await response.body?.cancel(); throw new Error('Player request failed') }
    const player: PlayerResponse = JSON.parse(new TextDecoder().decode(await readLimited(response, 3 * 1024 * 1024)))
    if (player.playabilityStatus?.status !== 'OK') {
      if (player.playabilityStatus?.status === 'LOGIN_REQUIRED' && /bot|automated|unusual traffic/i.test(player.playabilityStatus.reason ?? '')) throw new TranscriptBlockedError()
      throw new Error('Video unavailable')
    }
    const length = Number(player.videoDetails?.lengthSeconds) * 1000
    const duration = Number.isSafeInteger(length) && length > 0 && length <= maxVideoTime ? length : null
    const tracks = player.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? []
    const track = Array.isArray(tracks) ? tracks.find(track => track.languageCode === 'en') ?? tracks[0] : undefined
    if (typeof track?.baseUrl !== 'string') return { duration, transcript: [] as TranscriptCue[] }
    const url = new URL(track.baseUrl)
    if (url.protocol !== 'https:' || url.hostname !== 'www.youtube.com' || url.pathname !== '/api/timedtext') throw new Error('Invalid caption URL')
    url.searchParams.set('fmt', 'json3')
    const { response: captions } = await fetchPublic(url.href, fetcher, deadline)
    const data = JSON.parse(new TextDecoder().decode(await readLimited(captions, 2 * 1024 * 1024))) as { events?: { tStartMs: number; dDurationMs: number; segs?: { utf8?: string }[] }[] }
    const transcript = validateTranscript((data.events ?? []).filter(event => event.segs?.some(seg => seg.utf8?.trim())).map(event => ({
      start: event.tStartMs, end: event.tStartMs + event.dDurationMs, text: event.segs!.map(seg => seg.utf8 ?? '').join('').trim(),
    })), duration)
    return { duration, transcript }
  } catch (error) {
    if (signal?.aborted) throw new ImportError('The import was cancelled. Please try again.')
    if (error instanceof TranscriptBlockedError) throw error
    throw new ImportError('Could not fetch captions from YouTube. Try again or import subtitles below.')
  }
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
    const captured = await fetchVideoTranscript(video.url, fetcher, signal)
    duration = captured.duration
    transcript = captured.transcript
  } catch { /* Saving a video does not depend on its captions. */ }
  if (signal?.aborted) throw new ImportError('The import was cancelled. Please try again.')
  return { ...video, title: (metadata.title as string).slice(0, 500), author: typeof metadata.author_name === 'string' ? metadata.author_name.slice(0, 200) : null, duration, transcript }
}

export function videoMarkdown(title: string, url: string, cues: TranscriptCue[]): string {
  const escape = (value: string) => value.replace(/[\\`*_[\]<>#~|]/g, '\\$&')
  return `# ${escape(title)}\n\nSource: ${url}\n\n${cues.map(cue => `[${videoTime(cue.start)}](${url}&t=${Math.floor(cue.start / 1000)}) ${escape(cue.text)}`).join('\n\n')}\n`
}
