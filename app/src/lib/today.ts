import { supabase } from './supabase'
import { localDate } from './entries'
import { syncDeps } from './syncDeps'

/** The most recently touched entry dated today, from the server or (offline) the local drafts. */
export async function findTodaysEntry(userId: string): Promise<string | null> {
  const today = localDate()
  const local = (await syncDeps.store.all())
    .filter((d) => d.userId === userId && d.content.entry_date === today)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]
  try {
    const { data, error } = await supabase
      .from('entries')
      .select('id, updated_at')
      .eq('entry_date', today)
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
