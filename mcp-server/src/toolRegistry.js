import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const TOOLS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'tools')

// Auto-discovers every `*.tools.js` file under `src/tools/` and concatenates their exported `tools`
// arrays. Each tool cluster ticket only ever adds new files here — never edits a shared registration
// list — so independent tickets never collide on the same line of the same file.
export async function loadTools() {
  const files = readdirSync(TOOLS_DIR)
    .filter((name) => name.endsWith('.tools.js'))
    .sort()

  const tools = []
  const seen = new Set()

  for (const file of files) {
    const mod = await import(pathToFileURL(join(TOOLS_DIR, file)).href)
    if (!Array.isArray(mod.tools)) {
      throw new Error(`${file} must export a "tools" array`)
    }
    for (const tool of mod.tools) {
      if (!tool.name || typeof tool.name !== 'string') {
        throw new Error(`${file} exports a tool with no string "name"`)
      }
      if (seen.has(tool.name)) {
        throw new Error(`Duplicate tool name "${tool.name}" (registered again from ${file})`)
      }
      seen.add(tool.name)
      tools.push(tool)
    }
  }

  return tools
}
