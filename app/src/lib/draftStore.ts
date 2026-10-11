import { createStore, promisifyRequest, type UseStore } from 'idb-keyval'
import type { EntryContent } from './entries'

/**
 * The local draft buffer. One record per entry id, shared by every tab of this origin.
 * It is the single source of truth for text the server hasn't confirmed yet.
 */
export type Draft = {
  id: string
  userId: string
  content: EntryContent
  /** Bumped on every local write, by any tab. */
  seq: number
  /** Highest seq the server has confirmed. Dirty while seq > savedSeq. */
  savedSeq: number
  /** Server revision the confirmed content sits on (0 = never saved). Sent with each save. */
  baseRevision: number
  /** Text from another tab that a later write replaced. Sent to the server and kept as versions. */
  displaced: EntryContent[]
  updatedAt: number
}

export const DELETE = Symbol('delete')
export type Mutator = (cur: Draft | undefined) => Draft | undefined | typeof DELETE

export interface DraftStore {
  get(id: string): Promise<Draft | undefined>
  all(): Promise<Draft[]>
  /** Read-modify-write in a single IndexedDB transaction, so tabs can't interleave. */
  mutate(id: string, fn: Mutator): Promise<Draft | undefined>
}

export function idbDraftStore(dbName = 'daftar', storeName = 'drafts'): DraftStore {
  let store: UseStore | null = null
  const s = () => (store ??= createStore(dbName, storeName))

  return {
    get: (id) => s()('readonly', (st) => promisifyRequest(st.get(id) as IDBRequest<Draft | undefined>)),
    all: () => s()('readonly', (st) => promisifyRequest(st.getAll() as IDBRequest<Draft[]>)),
    mutate: (id, fn) =>
      s()('readwrite', (st) => {
        return new Promise<Draft | undefined>((resolve, reject) => {
          const req = st.get(id)
          req.onerror = () => reject(req.error)
          req.onsuccess = () => {
            let next: Draft | undefined | typeof DELETE
            try {
              next = fn(req.result as Draft | undefined)
            } catch (e) {
              reject(e)
              return
            }
            if (next === DELETE) st.delete(id)
            else if (next !== undefined) st.put(next, id)
            const result = next === DELETE ? undefined : next ?? (req.result as Draft | undefined)
            promisifyRequest(st.transaction).then(() => resolve(result), reject)
          }
        })
      }),
  }
}
