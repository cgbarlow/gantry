import { signal, effect } from '@preact/signals'

const STORAGE_KEY = 'gantry:editor-wrap'

function safeGetItem(key) {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key)
  } catch {
    return null
  }
}

function safeSetItem(key, value) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value)
  } catch {
    // Ignore — see the comment above safeGetItem.
  }
}

function initialWrap() {
  const stored = safeGetItem(STORAGE_KEY)
  if (stored === 'true') return true
  if (stored === 'false') return false
  return true
}

export const wrap = signal(initialWrap())

effect(() => {
  safeSetItem(STORAGE_KEY, String(wrap.value))
})
