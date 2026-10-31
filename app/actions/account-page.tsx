import type { Handle } from 'remix/component'
import { AppShell } from '../ui/app-shell.tsx'
import { routes } from '../routes.ts'

export function AccountPage(handle: Handle<{ email: string; token?: string; tokenCreatedAt?: string; endpoint: string }>) {
  return () => <AppShell title="Account — Juniper" nav={<a class="text-xs text-muted" href={routes.home.href()}>Library</a>}>
    <section class="mx-auto max-w-[600px] py-12">
      <h1 class="text-2xl font-semibold">Your account</h1>
      <p class="mt-2 text-sm text-muted">{handle.props.email}</p>
      <h2 class="mt-10 text-lg font-semibold">Connect an agent</h2>
      <p class="mt-2 text-sm leading-relaxed text-muted">Use a personal token to let your agent search and read your library.</p>
      <p class="mt-5 text-xs font-medium">MCP endpoint</p>
      <code class="mt-2 block break-all rounded-lg border border-line bg-surface p-3 text-xs">{handle.props.endpoint}</code>
      {handle.props.token && <div role="status" class="mt-5 rounded-lg border border-line-strong bg-surface p-4">
        <p class="text-sm font-medium">Copy your new token now.</p>
        <p class="mt-1 text-xs text-muted">It will only be shown once. Use it in the Authorization: Bearer header.</p>
        <code class="mt-3 block break-all select-all text-xs">{handle.props.token}</code>
      </div>}
      <p class="mt-5 text-xs text-muted">{handle.props.tokenCreatedAt ? 'A token is active. Creating another replaces it.' : 'You have no active token.'}</p>
      <form method="post" action={routes.mcpToken.href()} class="mt-4 flex flex-wrap gap-3">
        <button name="intent" value="create" class="rounded-lg bg-ink px-4 py-2.5 text-xs font-semibold text-paper">Create token</button>
        {handle.props.tokenCreatedAt && <button name="intent" value="revoke" class="rounded-lg border border-line-strong px-4 py-2.5 text-xs">Revoke token</button>}
      </form>
    </section>
  </AppShell>
}
