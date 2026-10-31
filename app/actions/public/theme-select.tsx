import { clientEntry, on, type Handle } from 'remix/component'
import { normalizeTheme, THEME_STORAGE_KEY, type Theme } from './theme.ts'

export const ThemeSelect = clientEntry(import.meta.url + '#ThemeSelect', function ThemeSelect(handle: Handle) {
  let theme: Theme = 'system'
  let ready = false

  function applyTheme(value: unknown) {
    theme = normalizeTheme(value)
    document.documentElement.dataset.theme = theme
    handle.update()
  }

  handle.queueTask(() => {
    let saved = document.documentElement.dataset.theme
    try { saved = localStorage.getItem(THEME_STORAGE_KEY) ?? undefined } catch {}
    ready = true
    applyTheme(saved)
    // Document navigation reconciles <html> attributes while reusing this control.
    // Restore the preference in the same frame, before the browser paints.
    const observer = new MutationObserver(() => {
      if (document.documentElement.dataset.theme !== theme) document.documentElement.dataset.theme = theme
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    handle.signal.addEventListener('abort', () => observer.disconnect(), { once: true })
    window.addEventListener('storage', event => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) applyTheme(event.newValue)
    }, { signal: handle.signal })
  })

  return () => <select
    aria-label="Color theme"
    title="Color theme"
    class="max-w-[88px] rounded-md bg-paper px-1 py-1 text-xs text-muted hover:bg-control hover:text-ink"
    value={theme}
    disabled={!ready}
    mix={on('change', event => {
      applyTheme(event.currentTarget.value)
      try {
        if (theme === 'system') localStorage.removeItem(THEME_STORAGE_KEY)
        else localStorage.setItem(THEME_STORAGE_KEY, theme)
      } catch {}
    })}
  >
    <option value="system">System</option>
    <option value="light">Light</option>
    <option value="dark">Dark</option>
  </select>
})
