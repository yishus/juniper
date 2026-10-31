export type Theme = 'light' | 'dark' | 'system'
export const THEME_STORAGE_KEY = 'juniper:theme'

export function normalizeTheme(value: unknown): Theme {
  return value === 'light' || value === 'dark' ? value : 'system'
}

// Runs before styles load so a saved preference is applied before the first paint.
// With no override (or no JavaScript), CSS follows the system color scheme.
export const THEME_INIT_SCRIPT = `try{let theme=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(theme==='light'||theme==='dark')document.documentElement.dataset.theme=theme}catch{}`
