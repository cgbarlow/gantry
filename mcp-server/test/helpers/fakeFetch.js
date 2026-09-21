// Stubs the global `fetch` gantryClient.js calls directly — the one seam every test in this package
// mocks at (docs/adr/0043: "no live gantry serve" in any test here).
//
// `handler({ url: URL, method, headers, body })` returns `{ status, body }` (body JSON-stringified for
// the response) or `undefined`/throws for an unmatched route. Returns a restore function.
export function stubFetch(handler) {
  const original = globalThis.fetch
  const calls = []

  globalThis.fetch = async (input, init = {}) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url)
    const method = init.method ?? 'GET'
    const headers = init.headers ?? {}
    const call = { url, method, headers, body: init.body }
    calls.push(call)

    const result = await handler(call)
    if (!result) {
      throw new Error(`No fake route for ${method} ${url.pathname}${url.search}`)
    }
    const bodyText = result.body !== undefined ? JSON.stringify(result.body) : ''
    return new Response(bodyText, {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  globalThis.fetch.calls = calls
  globalThis.fetch.restore = () => {
    globalThis.fetch = original
  }

  return globalThis.fetch
}
