import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

function resolveEntry(pkg) {
  const exportsField = pkg.exports
  let entry
  if (typeof exportsField === 'string') {
    entry = exportsField
  } else if (exportsField?.['.']) {
    const dot = exportsField['.']
    entry = typeof dot === 'string' ? dot : (dot.import?.default ?? dot.import ?? dot.default)
  } else if (exportsField?.import) {
    entry = typeof exportsField.import === 'string' ? exportsField.import : exportsField.import.default
  }
  entry ??= pkg.module ?? pkg.main ?? 'index.js'
  return entry.replace(/^\.\//, '')
}

/**
 * Walks node_modules from a set of root specifiers, following each package's own "dependencies", and returns a browser import map that points every bare specifier at its real ESM entry file under /node_modules/ — so the web form can `import` these packages with no bundler, exactly as installed by `npm install`.
 */
export function buildImportMap(rootSpecifiers, options = {}) {
  const nodeModulesDir = options.nodeModulesDir ?? 'node_modules'
  const imports = {}
  const seen = new Set()
  const queue = [...rootSpecifiers]

  while (queue.length) {
    const spec = queue.shift()
    if (seen.has(spec)) continue
    seen.add(spec)

    const pkgJsonPath = join(nodeModulesDir, spec, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))

    imports[spec] = `/node_modules/${spec}/${resolveEntry(pkg)}`
    for (const dep of Object.keys(pkg.dependencies ?? {})) queue.push(dep)
  }

  return { imports }
}
