// #328: a stand-in for Anthropic's prompt cache, so a fake Anthropic AI Provider can report the usage the real one would: how much of each
// request was read from the cache, how much was written to it, and how much was neither. It follows Anthropic's published rules:
//   * a request is tools, then system, then messages, and the cache is a prefix match: an entry is the request up to a block's end;
//   * an entry is written at each cache point (`cache_control`), and only when the prefix there is at least `minTokens` long;
//   * a cache point reads the longest entry it can find by walking back from itself at most `lookback` positions (20 on Anthropic);
//   * `collapseToolRuns`: the Claude API counts a run of tool calls, or of tool results, as one position. That is not promised wherever
//     OpenRouter sends a request, so it is off by default: every block is a position, the stricter reading.
// Tokens are about four characters each, as Gantry's own estimates are. A real capture would say exactly; this says the same thing roughly.
import { createHash } from 'node:crypto'

/** The blocks of an Anthropic request body in the order the cache sees them: `{ text, mark, type }`, `text` leaving the cache point out. */
export function cacheBlocks(raw) {
  const plain = ({ cache_control, ...rest }) => rest
  const system = typeof raw.system === 'string' ? (raw.system ? [{ type: 'text', text: raw.system }] : []) : raw.system ?? []
  const blocks = [...(raw.tools ?? []), ...system].map((b) => ({ text: JSON.stringify(plain(b)), mark: Boolean(b.cache_control), type: 'head' }))
  for (const m of raw.messages) {
    const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
    content.forEach((b, i) => blocks.push({ text: (i === 0 ? m.role : '') + JSON.stringify(plain(b)), mark: Boolean(b.cache_control), type: b.type, first: i === 0 }))
  }
  return blocks
}

/** A cache shared by a run of requests. `usage(raw)` answers one request the way Anthropic's `usage` does, and remembers what it wrote. */
export function createAnthropicCache({ lookback = 20, collapseToolRuns = false, minTokens = 1024 } = {}) {
  const written = new Set()
  const tokens = (chars) => Math.round(chars / 4)
  return {
    usage(raw) {
      const blocks = cacheBlocks(raw)
      const hash = createHash('sha256')
      let chars = 0
      // Each block's prefix: its key and length, and the position it is part of.
      let position = -1
      const prefixes = blocks.map((block, i) => {
        hash.update(block.text)
        chars += block.text.length
        const run = collapseToolRuns && (block.type === 'tool_use' || block.type === 'tool_result') && !block.first && blocks[i - 1].type === block.type
        if (!run) position++
        return { key: hash.copy().digest('hex'), chars, position }
      })
      // A position's entry is at its last block.
      const ends = new Map()
      prefixes.forEach((p, i) => ends.set(p.position, i))
      let read = 0
      let lastMark = -1
      blocks.forEach((block, i) => {
        if (!block.mark) return
        lastMark = i
        const own = prefixes[i]
        const candidates = [i, ...Array.from({ length: lookback - 1 }, (_, back) => ends.get(own.position - back - 1)).filter((j) => j !== undefined && j < i)]
        const hit = candidates.find((j) => written.has(prefixes[j].key))
        if (hit !== undefined) read = Math.max(read, prefixes[hit].chars)
      })
      const markedChars = lastMark >= 0 ? prefixes[lastMark].chars : 0
      const write = Math.max(0, markedChars - read)
      blocks.forEach((block, i) => {
        if (block.mark && tokens(prefixes[i].chars) >= minTokens) written.add(prefixes[i].key)
      })
      const total = prefixes.at(-1)?.chars ?? 0
      return {
        input_tokens: tokens(total - read - (tokens(markedChars) >= minTokens ? write : 0)),
        cache_read_input_tokens: tokens(read),
        cache_creation_input_tokens: tokens(markedChars) >= minTokens ? tokens(write) : 0,
      }
    },
  }
}
