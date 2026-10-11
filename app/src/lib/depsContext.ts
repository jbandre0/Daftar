import { createContext, useContext } from 'react'
import { syncDeps } from './syncDeps'
import type { SyncDeps } from './sync'

export const SyncDepsContext = createContext<SyncDeps>(syncDeps)
export const useSyncDeps = () => useContext(SyncDepsContext)
