/** Persist the user's default mockup photo in IndexedDB for reuse across sessions. */

const DB_NAME = 'cover-maker'
const DB_VERSION = 1
const STORE = 'mockup'
const DEFAULT_KEY = 'default'

export type StoredMockup = {
  name: string
  blob: Blob
  savedAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'))
  })
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

export async function saveDefaultMockup(
  blob: Blob,
  name: string,
): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    const record: StoredMockup = {
      name,
      blob,
      savedAt: Date.now(),
    }
    await idbReq(store.put(record, DEFAULT_KEY))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Save mockup failed'))
      tx.onabort = () => reject(tx.error ?? new Error('Save mockup aborted'))
    })
  } finally {
    db.close()
  }
}

export async function loadDefaultMockup(): Promise<StoredMockup | null> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const value = await idbReq<StoredMockup | undefined>(store.get(DEFAULT_KEY))
    if (!value?.blob) return null
    return value
  } finally {
    db.close()
  }
}

export async function clearDefaultMockup(): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    await idbReq(store.delete(DEFAULT_KEY))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Clear mockup failed'))
      tx.onabort = () => reject(tx.error ?? new Error('Clear mockup aborted'))
    })
  } finally {
    db.close()
  }
}
