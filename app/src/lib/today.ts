import { supabase } from './supabase'
import { localDate } from './entries'
import { syncDeps } from './syncDeps'
import { preview } from './preview'

/** The most recently touched entry dated today, from the server or (offline) the local drafts. */
export async function findTodaysEntry(userId: string): Promise<string | null> {
  const today = localDate()
  const local = (await syncDeps.store.all())
    .filter((d) => d.userId === userId && d.content.entry_date === today && !d.content.is_letter && !d.content.sealed)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  try {
    if (preview.remoteToday) {
      const r = await preview.remoteToday(today)
      if (!r) return local?.id ?? null
      return local && local.updatedAt > Date.parse(r.updated_at) ? local.id : r.id
    }
    const { data, error } = await supabase
      .from('entries')
      .select('id, updated_at')
      .eq('entry_date', today)
      .eq('is_letter', false)
      .is('deleted_at', null)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) throw error
    if (!data) return local?.id ?? null
    if (local && local.updatedAt > Date.parse(data.updated_at)) return local.id
    return data.id
  } catch {
    return local?.id ?? null
  }
}
