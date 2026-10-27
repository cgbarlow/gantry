import { register } from 'node:module'

// #198 — loaded with `node --import` to run the CLI as if the optional `playwright` package had
// never been installed (`npm install --omit=optional`, or the server container): every import of
// it fails exactly as Node reports a missing package. Test-only.
const HOOK = `
export async function resolve(specifier, context, next) {
  if (specifier === 'playwright' || specifier.startsWith('playwright/')) {
    const err = new Error("Cannot find package 'playwright'")
    err.code = 'ERR_MODULE_NOT_FOUND'
    throw err
  }
  return next(specifier, context)
}
`

register(`data:text/javascript,${encodeURIComponent(HOOK)}`)
