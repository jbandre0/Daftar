import type { ComponentType } from 'react'
import type { AuthState } from '../auth'
import type { EntrySummary } from './entries'
import type { Organize } from './organize'
import type { Rpc } from './vault'

/**
 * Dev-only preview mode (see src/dev/previewBackend.ts, loaded only when `import.meta.env.DEV`).
 * Open `/?preview=1` on the dev server to use the whole app on sample data without signing in.
 * In production `active` stays false and none of the hooks below are ever set.
 */
export const preview: {
  active: boolean
  auth?: AuthState
  organize?: Organize
  recent?: (limit: number) => Promise<EntrySummary[]>
  range?: (start: string, end: string | null) => Promise<EntrySummary[]>
  remoteToday?: (today: string) => Promise<{ id: string; updated_at: string } | null>
  rpc?: Rpc
  Badge?: ComponentType
} = { active: false }
