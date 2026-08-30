/**
 * Pure helper: move an item within an array from `from` to `to`.
 * - Clamps out-of-range indices to [0, list.length-1]
 * - No-op when from===to (after clamping) or empty list
 * - Never mutates `list`; returns a new array
 */
export function reorder(list, from, to) {
  const len = list.length
  if (len === 0) return [...list]
  // clamp
  let f = Math.max(0, Math.min(from, len - 1))
  let t = Math.max(0, Math.min(to, len - 1))
  if (f === t) return [...list]
  const next = [...list]
  const [item] = next.splice(f, 1)
  next.splice(t, 0, item)
  return next
}
