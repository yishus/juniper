import type { Handle } from 'remix/component'

// Heroicons 2.2.0, 24px outline set, adapted to Remix components.
// SVG paths: https://github.com/tailwindlabs/heroicons
// License: public/licenses/heroicons.txt
interface IconProps { class?: string }

function createIcon(path: string) {
  return function Icon(handle: Handle<IconProps>) {
    return () => (
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true" focusable="false" data-slot="icon" class={handle.props.class ?? 'size-5 shrink-0'}>
        <path d={path} stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    )
  }
}

export const LinkIcon = createIcon(
  "M13.19 8.688a4.5 4.5 0 0 1 1.242 7.244l-4.5 4.5a4.5 4.5 0 0 1-6.364-6.364l1.757-1.757m13.35-.622 1.757-1.757a4.5 4.5 0 0 0-6.364-6.364l-4.5 4.5a4.5 4.5 0 0 0 1.242 7.244",
)

export const MagnifyingGlassIcon = createIcon(
  "m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z",
)

export const BookmarkIcon = createIcon(
  "M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z",
)

export const ArrowDownTrayIcon = createIcon(
  "M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5M16.5 12 12 16.5m0 0L7.5 12m4.5 4.5V3",
)

export const XMarkIcon = createIcon(
  "M6 18 18 6M6 6l12 12",
)

export const ArrowUpIcon = createIcon(
  "M4.5 10.5 12 3m0 0 7.5 7.5M12 3v18",
)

export const ArrowUpRightIcon = createIcon(
  "m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25",
)

export const DocumentTextIcon = createIcon(
  "M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z",
)

export const ArrowPathIcon = createIcon(
  "M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99",
)

export const ArrowLeftIcon = createIcon(
  "M10.5 19.5 3 12m0 0 7.5-7.5M3 12h18",
)

export const PlusIcon = createIcon(
  "M12 4.5v15m7.5-7.5h-15",
)

export const EllipsisVerticalIcon = createIcon(
  'M12 5.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm0 7.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z',
)

export const TrashIcon = createIcon(
  "m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0",
)
