// #297 (map #238, decided in #249): what the editor and the Interview page know about Out of date Fields, and how they get it.
//
// `loadOutOfDate` (web/lib/outOfDateLoad.js) gathers what web/lib/outOfDate.js needs from the same stores every workspace kind already has (the Source document
// store, the decisions log store, the Stages' saved content) and returns the flags. It runs on opening the Instance and after every
// Source document change or Save, never on a timer. Only what it needs is read: the other Stages' content is fetched only when a
// document has changed or a draft recorded an earlier Field as an input, so an Instance with neither costs one list of its documents.
import { signal } from '@preact/signals'

/** Bumped by the Source documents panel each time it has listed the documents (on opening and after every change), so detection runs again. */
export const sourceListTick = signal(0)

/** The latest result for the Instance on screen: `{ key, flags, newSince, sources }`. */
export const outOfDateState = signal({ key: '', flags: [], newSince: [], sources: [], unchecked: [] })

export { loadOutOfDate } from './outOfDateLoad.js'
