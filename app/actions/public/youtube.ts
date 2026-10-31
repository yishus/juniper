import type { TranscriptCue } from '../../data/types.ts'
import { validateNote, type HighlightInput } from './highlight-model.ts'

export const maxVideoTime = 7 * 24 * 60 * 60 * 1000

export function youtubeVideo(input: string): { videoId: string; url: string } | null {
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null
    const host = url.hostname.toLowerCase()
    const videoId = host === 'youtu.be' ? /^\/([^/]+)\/?$/.exec(url.pathname)?.[1]
      : ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)
        ? url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed|live)\/([^/]+)\/?$/.exec(url.pathname)?.[1]
        : null
    return videoId && /^[\w-]{11}$/.test(videoId) ? { videoId, url: `https://www.youtube.com/watch?v=${videoId}` } : null
  } catch { return null }
}

export function videoTime(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000)
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .slice(seconds >= 3600 ? 0 : 1).map((part, index) => index ? String(part).padStart(2, '0') : String(part)).join(':')
}

export function parseVideoTime(value: string): number {
  if (!/^\d+(?::[0-5]\d){0,2}(?:\.\d{1,3})?$/.test(value.trim())) return NaN
  return Math.round(value.trim().split(':').reduce((total, part) => total * 60 + Number(part), 0) * 1000)
}

export function segmentText(cues: TranscriptCue[], start: number, end: number): string {
  return cues.filter(cue => cue.start < end && cue.end > start).map(cue => cue.text).join(' ').slice(0, 10000)
}

export function validateVideoHighlight(value: Record<string, unknown>, cues: TranscriptCue[], duration: number | null): HighlightInput {
  const start = typeof value.start === 'string' ? parseVideoTime(value.start) : value.start
  const end = typeof value.end === 'string' ? parseVideoTime(value.end) : value.end
  if (typeof start !== 'number' || typeof end !== 'number' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
      start < 0 || end <= start || end > (duration ?? maxVideoTime)) {
    throw new Error('Choose an end after the start, within the video. Use minutes:seconds or hours:minutes:seconds.')
  }
  return { start, end, quote: segmentText(cues, start, end) || `Video highlight · ${videoTime(start)}–${videoTime(end)}`, note: validateNote(value.note ?? '') }
}
