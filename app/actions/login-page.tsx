import type { Handle } from 'remix/component'
import { Document } from './document.tsx'
import { routes } from '../routes.ts'
import { ThemeSelect } from './public/theme-select.tsx'

export function LoginPage(handle: Handle<{ returnTo: string; siteKey?: string; signup?: boolean; email?: string; error?: string; unavailable?: boolean }>) {
  return () => <Document title={`${handle.props.signup ? 'Create account' : 'Sign in'} — Juniper`} head={<>
    <link rel="stylesheet" href="/library.css" />
    {!handle.props.unavailable && <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>}
  </>}>
    <main class="mx-auto flex min-h-screen max-w-[400px] flex-col justify-center px-6 py-12 wrap-anywhere">
      <div class="mb-10 flex items-center justify-between gap-4">
        <a data-rmx-document href={routes.login.href()} class="text-[28px] font-bold tracking-[-1.5px]" aria-label="Juniper sign in">juniper</a>
        <ThemeSelect />
      </div>
      <h1 class="text-2xl font-semibold tracking-tight">{handle.props.signup ? 'Create your account' : 'Sign in'}</h1>
      <p class="mt-2 text-sm leading-relaxed text-muted">{handle.props.signup ? 'Juniper is open to invited email addresses.' : 'Your saved articles, all in one quiet place.'}</p>
      {handle.props.unavailable ? <p role="alert" class="mt-6 text-sm text-muted">Sign-in is temporarily unavailable. Please try again later.</p> : <form data-rmx-document method="post" action={handle.props.signup ? routes.signupSubmit.href() : routes.loginSubmit.href()} class="mt-8 flex flex-col gap-5">
        <input type="hidden" name="returnTo" value={handle.props.returnTo} />
        {handle.props.signup && <div>
          <label for="signup-name" class="mb-2 block text-xs font-medium">Name</label>
          <input id="signup-name" name="name" type="text" autoComplete="name" required maxLength={100} class="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-ink" />
        </div>}
        <div>
          <label for="login-email" class="mb-2 block text-xs font-medium">Email</label>
          <input id="login-email" name="email" type="email" autoComplete="username" required maxLength={254} value={handle.props.email ?? ''} class="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-ink" />
        </div>
        <div>
          <label for="login-password" class="mb-2 block text-xs font-medium">Password</label>
          <input id="login-password" name="password" type="password" autoComplete={handle.props.signup ? 'new-password' : 'current-password'} required minLength={handle.props.signup ? 12 : undefined} maxLength={128} class="w-full rounded-lg border border-line-strong bg-surface px-3 py-2.5 text-sm outline-none focus:border-ink" />
          {handle.props.signup && <p class="mt-2 text-xs text-muted">Use at least 12 characters.</p>}
        </div>
        <div class="cf-turnstile" data-sitekey={handle.props.siteKey} data-action="auth" data-theme="auto" data-size="flexible"></div>
        <noscript><p class="text-xs text-muted">Enable JavaScript to complete the security check.</p></noscript>
        {handle.props.error && <p role="alert" class="rounded-lg border border-line-strong bg-surface p-3 text-xs leading-relaxed">{handle.props.error}</p>}
        <button type="submit" class="rounded-lg bg-ink px-4 py-3 text-sm font-semibold text-paper transition-colors hover:bg-accent-hover">{handle.props.signup ? 'Create account' : 'Sign in'}</button>
        <p class="text-center text-xs text-muted">{handle.props.signup ? 'Already have an account? ' : 'New to Juniper? '}<a data-rmx-document class="text-ink underline underline-offset-4" href={(handle.props.signup ? routes.login : routes.signup).href(undefined, { searchParams: { returnTo: handle.props.returnTo } })}>{handle.props.signup ? 'Sign in' : 'Create an account'}</a></p>
      </form>}
    </main>
  </Document>
}
