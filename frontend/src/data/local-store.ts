import { SEED_ROWS } from './seed'
import { SEED_BACKFILL_TASKS, SEED_CRACK_OBSERVATIONS } from './crack-seed'
import type { BackfillTask, CrackObservation } from './crack-backfill'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：裂缝观测序列与补录任务独立成集，旧版缓存缺少这些键，直接换版本号避免读到半套数据。
const STORAGE_KEY = 'geohazard-monitor-prevention:entries:v2'

type DomainMap = {
  crack_observations: CrackObservation[]
  crack_backfill_tasks: BackfillTask[]
}

type Stored = Record<string, unknown> & Partial<DomainMap>

function seedAll(): Stored {
  return {
    ...clone(SEED_ROWS),
    crack_observations: clone(SEED_CRACK_OBSERVATIONS),
    crack_backfill_tasks: clone(SEED_BACKFILL_TASKS),
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Stored {
  const fallback = seedAll()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Stored
    // 旧版本或缺键的缓存：用种子补齐，保证领域集合一定存在。
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Stored | null = null

function all(): Stored {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function allRows(): Record<string, EntryRow[]> {
  return all() as Record<string, EntryRow[]>
}

export function listRows(key: string): EntryRow[] {
  return (all()[key] as EntryRow[] | undefined) ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...all(), [key]: rows }
  persist(next)
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function listDomain<K extends keyof DomainMap>(key: K): DomainMap[K] {
  const rows = all()[key]
  return (rows as DomainMap[K] | undefined) ?? (([] as unknown) as DomainMap[K])
}

export function saveDomain<K extends keyof DomainMap>(key: K, rows: DomainMap[K]): void {
  persist({ ...all(), [key]: rows })
}

export function nextDomainId(key: keyof DomainMap): number {
  const rows = listDomain(key) as Array<{ id: number }>
  return rows.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

function persist(next: Stored): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function storageKey(): string {
  return STORAGE_KEY
}
