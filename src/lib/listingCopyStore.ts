/** Persist listing-copy prefs (free remaining hint, optional API key, last copy). */

import type { ListingCopyResult } from './listingLimits'
import { LISTING_FREE_QUOTA } from './listingLimits'

const DB_NAME = 'cover-maker'
const DB_VERSION = 2
const STORE = 'listingCopy'
const KEY = 'prefs'

export type ListingCopyPrefs = {
  freeRemaining: number
  userApiKey?: string
  rememberKey: boolean
  listingSubject: string
  guidelines: string
  lastCopy: ListingCopyResult | null
  updatedAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('mockup')) {
        db.createObjectStore('mockup')
      }
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

export function defaultListingCopyPrefs(): ListingCopyPrefs {
  return {
    freeRemaining: LISTING_FREE_QUOTA,
    rememberKey: false,
    listingSubject: '',
    guidelines: '',
    lastCopy: null,
    updatedAt: Date.now(),
  }
}

export async function loadListingCopyPrefs(): Promise<ListingCopyPrefs> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readonly')
    const store = tx.objectStore(STORE)
    const value = await idbReq<ListingCopyPrefs | undefined>(store.get(KEY))
    if (!value) return defaultListingCopyPrefs()
    return {
      ...defaultListingCopyPrefs(),
      ...value,
      freeRemaining:
        typeof value.freeRemaining === 'number'
          ? value.freeRemaining
          : LISTING_FREE_QUOTA,
    }
  } catch {
    return defaultListingCopyPrefs()
  } finally {
    db.close()
  }
}

export async function saveListingCopyPrefs(
  prefs: Partial<ListingCopyPrefs> & { clearKey?: boolean },
): Promise<ListingCopyPrefs> {
  const current = await loadListingCopyPrefs()
  const next: ListingCopyPrefs = {
    ...current,
    ...prefs,
    updatedAt: Date.now(),
  }
  if (prefs.clearKey || prefs.rememberKey === false) {
    delete next.userApiKey
  }
  if (prefs.rememberKey === false) {
    next.rememberKey = false
  }
  if (prefs.userApiKey != null && prefs.rememberKey) {
    next.userApiKey = prefs.userApiKey
    next.rememberKey = true
  } else if (prefs.userApiKey != null && current.rememberKey) {
    next.userApiKey = prefs.userApiKey
  } else if (!next.rememberKey) {
    delete next.userApiKey
  }

  const db = await openDb()
  try {
    const tx = db.transaction(STORE, 'readwrite')
    const store = tx.objectStore(STORE)
    await idbReq(store.put(next, KEY))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('Save listing prefs failed'))
      tx.onabort = () => reject(tx.error ?? new Error('Save listing prefs aborted'))
    })
  } finally {
    db.close()
  }
  return next
}
