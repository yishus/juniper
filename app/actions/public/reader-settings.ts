export const MIN_FONT_SIZE = 14
export const MAX_FONT_SIZE = 28
export const READER_SETTINGS_KEY = 'juniper:reader-settings'
export type ReaderSettings = { font: 'sans' | 'serif'; size: number }
export const DEFAULT_READER_SETTINGS: ReaderSettings = { font: 'serif', size: 18 }

export function normalizeReaderSettings(value: unknown): ReaderSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_READER_SETTINGS }
  const candidate = value as Partial<ReaderSettings>
  return {
    font: candidate.font === 'sans' ? 'sans' : 'serif',
    size: typeof candidate.size === 'number' && Number.isFinite(candidate.size)
      ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(candidate.size)))
      : DEFAULT_READER_SETTINGS.size,
  }
}
