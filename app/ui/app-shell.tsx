import type { Handle, RemixNode } from 'remix/component'
import { Document } from '../actions/document.tsx'
import { routes } from '../routes.ts'
import { ThemeSelect } from '../actions/public/theme-select.tsx'

export function AppShell(handle: Handle<{ title: string; children?: RemixNode; nav?: RemixNode }>) {
  return () => (
    <Document title={handle.props.title} head={<link rel="stylesheet" href="/library.css" />}>
      <div class="mx-auto flex min-h-screen max-w-[1160px] flex-col px-[56px] max-[760px]:px-6 max-[420px]:px-[18px] min-[1400px]:max-w-[1220px] min-[1400px]:px-[76px]">
        <header class="flex min-h-[88px] flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-line py-5 max-[760px]:min-h-[76px]">
          <a class="text-[28px] leading-none font-bold tracking-[-1.5px] max-[760px]:text-[25px]" href={routes.home.href()} aria-label="Juniper home">juniper</a>
          <nav aria-label="Main navigation" class="flex flex-wrap items-center gap-4 max-[760px]:gap-2">
            {handle.props.nav}
            <ThemeSelect />
            <a href={routes.account.href()} class="rounded-md px-2 py-1 text-xs text-muted hover:bg-control hover:text-ink">Account</a>
            <form data-rmx-document method="post" action={routes.logout.href()}>
              <button type="submit" class="rounded-md px-2 py-1 text-xs text-muted hover:bg-control hover:text-ink">Sign out</button>
            </form>
          </nav>
        </header>
        <main class="flex-1">{handle.props.children}</main>
      </div>
    </Document>
  )
}
