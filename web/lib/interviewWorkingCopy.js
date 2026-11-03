// #290 (parent #238, docs/adr/0064): the **working copy** of an AI interview. Between Saves the browser keeps the unsaved part of a
// session (its drafts, the answers not yet in the committed log, the open round of cards and the AI's side of the history it needs
// to carry on) so closing the tab without pausing loses nothing, and the same browser resumes exactly where it stopped.
//
// The copy is never the truth. If the committed log has moved on since the copy began (the same architect saved from another
// browser, or someone else's session did), the committed log wins and the copy is set aside with a notice. Nothing in it is a key:
// an AI Provider is referred to by its id in this browser, and the AI Providers list holds the key (ADR-0061).
//
// Storage is `localStorage` and every access can fail (a private window, blocked site data, a full quota), so each call is wrapped
// and a failure is reported as "no copy kept", never thrown: the interview works the same without one.

export const WORKING_COPY_VERSION = 1
const PREFIX = 'gantry:interview-copy:'
const ASIDE_PREFIX = 'gantry:interview-copy-aside:'

const defaultStorage = () => {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * A copy, ready to store: `state` is `session.exportState()`, `committedIds` the ids of the committed log's entries the session knows,
 * `lastAiSave` the time of its own session's last save in the committed log.
 */
export function makeWorkingCopy({ state, committedIds = [], lastAiSave = null, now = () => new Date().toISOString() }) {
  return { version: WORKING_COPY_VERSION, savedAt: now(), session: state?.sessionId ?? null, committedIds: [...committedIds], lastAiSave, state }
}

/**
 * Whether a copy still matches the committed log: `'fresh'` when the committed log holds nothing the copy did not begin from, and
 * `'moved-on'` when it has an entry the copy does not know, or this session's own status line shows a later save than the copy's.
 */
export function copyStanding(copy, committedLog) {
  if (!copy || copy.version !== WORKING_COPY_VERSION) return 'unusable'
  const known = new Set(copy.committedIds ?? [])
  if ((committedLog?.entries ?? []).some((e) => !known.has(e.id))) return 'moved-on'
  const own = (committedLog?.status ?? []).find((s) => s.session === copy.session)
  if (own?.lastAiSave && String(own.lastAiSave) > String(copy.lastAiSave ?? '')) return 'moved-on'
  return 'fresh'
}

export function createWorkingCopyStore(storage = defaultStorage()) {
  const read = (key) => {
    try {
      const text = storage?.getItem(key)
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }
  const write = (key, value) => {
    try {
      if (!storage) return false
      storage.setItem(key, JSON.stringify(value))
      return true
    } catch {
      return false
    }
  }
  const remove = (key) => {
    try {
      storage?.removeItem(key)
    } catch {
      // nothing to clean up
    }
  }
  return {
    load: (key) => read(PREFIX + key),
    /** True when the copy was kept. */
    save: (key, copy) => write(PREFIX + key, copy),
    clear: (key) => remove(PREFIX + key),
    /** Puts the copy away under its own name so it is not lost, and takes it out of the way. */
    setAside(key, copy, reason = 'moved-on') {
      const kept = write(ASIDE_PREFIX + key, { ...copy, setAsideAt: new Date().toISOString(), reason })
      remove(PREFIX + key)
      return kept
    },
    aside: (key) => read(ASIDE_PREFIX + key),
    clearAside: (key) => remove(ASIDE_PREFIX + key),
  }
}
