import { supabase } from './supabase'
import { preview } from './preview'
import type { Rpc } from './vault'

export const supabaseRpc: Rpc = async (fn, args) => {
  if (preview.rpc) return preview.rpc(fn, args)
  const { data, error } = await supabase.rpc(fn, args)
  if (error) {
    if (error.code === '42501') {
      throw new Error('Restoring needs an active trial or an unlock, because it writes entries. You can still read and export everything.')
    }
    throw new Error("Couldn't reach the server. Nothing was changed by the step that failed; it's safe to try again.")
  }
  return data
}

export async function markExported(userId: string) {
  if (preview.active) return
  await supabase.from('profiles').update({ last_export_at: new Date().toISOString() }).eq('id', userId)
}

export function downloadText(name: string, text: string, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

export function sinceText(iso: string | null, now = Date.now()): string {
  if (!iso) return 'never'
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days} days ago`
}

export function formatBytes(n: number) {
  if (n < 1024 * 1024) return `${Math.max(0, Math.round(n / 1024))} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

const NUDGE_KEY = 'daftar.backupNudge.dismissedAt'
export const NUDGE_AFTER_DAYS = 30

/** The quiet backup nudge: only when the last export (or the account, if never) is over 30 days old. */
export function shouldNudge(lastExport: string | null, accountCreated: string | null, now = Date.now()): boolean {
  const ref = lastExport ?? accountCreated
  if (!ref || now - Date.parse(ref) < NUDGE_AFTER_DAYS * 86_400_000) return false
  try {
    const d = localStorage.getItem(NUDGE_KEY)
    if (d && now - Number(d) < NUDGE_AFTER_DAYS * 86_400_000) return false
  } catch {
    /* ignore */
  }
  return true
}

export function dismissNudge(now = Date.now()) {
  try {
    localStorage.setItem(NUDGE_KEY, String(now))
  } catch {
    /* ignore */
  }
}
