import type { ComponentType } from 'react'
import type { AuthState } from '../auth'
import type { BrowseFilters, BrowseRow, DayEntry } from './browse'
import type { EntrySummary } from './entries'
import type { Organize } from './organize'
import type { Rpc } from './vault'
import type { PhotoBackend } from './photoQueue'
import type { LetterRow } from './letters'
import type { MediaApi } from './photoRuntime'
import type { PromptRow } from './prompts'

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
  photos?: PhotoBackend & MediaApi
  letters?: () => Promise<LetterRow[]>
  prompts?: () => Promise<PromptRow[]>
  browse?: (f: BrowseFilters, offset: number) => Promise<{ rows: BrowseRow[]; total: number }>
  monthDays?: (start: string, end: string) => Promise<Record<string, number>>
  allDates?: () => Promise<string[]>
  day?: (date: string) => Promise<DayEntry[]>
  Badge?: ComponentType
} = { active: false }
