import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient } from '../src/gantryClient.js'
import { sourceFetchOffered, tools } from '../src/tools/sourceDocuments.tools.js'
import { tools as instanceTools } from '../src/tools/instanceContent.tools.js'
import { stubFetch } from './helpers/fakeFetch.js'

// #305 (docs/adr/0067): Source documents, decisions logs and Reviewed copies over MCP. Every test mocks at the HTTP seam; the routes
// themselves are tested against a real `gantry serve` in the main package (tests/mcpSourceSupport.test.js).

const BASE_URL = 'https://gantry.example.test'
const tool = (name) => tools.find((t) => t.name === name)
const payload = (result) => JSON.parse(result.content[0].text)

// A server-directory workspace named "srv-1" and, for the Provider-backed cases, "ws-1" with a PAT.
function route(extra) {
  return ({ url, method, headers, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: url.searchParams.get('slug') === 'ado-instance' ? 'ws-1' : 'srv-1', scope: 'scope-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1' }] }
    return extra({ url, method, headers, body })
  }
}

const withClient = async (handler, fn, workspacePats = {}) => {
  const fetch = stubFetch(route(handler))
  try {
    return await fn(createGantryClient({ baseUrl: BASE_URL, workspacePats }), fetch)
  } finally {
    fetch.restore()
  }
}

test('every tool in the cluster is registered with the instance addressing arguments', () => {
  const names = ['list_source_documents', 'read_source_document', 'upload_source_document', 'add_source_document_from_address', 'fetch_source_document_again', 'add_repository_source_document', 'find_repository_files', 'search_repository', 'list_repository_folder', 'read_repository_file', 'read_decisions_log', 'list_reviewed_copies', 'read_reviewed_copy', 'upload_reviewed_copy']
  assert.deepEqual(tools.map((t) => t.name), names)
  for (const t of tools) {
    for (const key of ['slug', 'scope', 'ref']) assert.ok(t.inputSchema[key], `${t.name} takes ${key}`)
  }
})

test('every tool refuses a call with neither slug nor ref, without touching the network', async () => {
  await withClient(
    () => {
      throw new Error('should not be called')
    },
    async (gantryClient, fetch) => {
      for (const t of tools) {
        const result = await t.handler({ id: 'x', filename: 'a.pdf', contentBase64: 'AAAA', files: [{ filename: 'a.docx', contentBase64: 'AAAA' }] }, { gantryClient })
        assert.equal(result.isError, true, t.name)
        assert.match(payload(result).error, /slug.*ref/, t.name)
      }
      assert.equal(fetch.calls.length, 0)
    }
  )
})

// ---------------------------------------------------------------------------
// Code repositories (#319, docs/adr/0072)
// ---------------------------------------------------------------------------

const HEAD = 'c0ffee1234567890abcdef1234567890abcdef12'
const POINTER = { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }
const repositoryEntries = [
  { id: 'billing-api', title: 'Billing API', uploadedAt: '2026-11-04T00:00:00Z', repository: POINTER },
  { id: 'brief', filename: 'brief.docx', title: 'Brief', size: 10 },
]
const requestBody = (call) => JSON.parse(call.body)

test('add_repository_source_document has gantry serve check the workspace credential can read it, then keeps only the pointer', async () => {
  const handler = ({ url, method, body }) => {
    if (url.pathname === '/api/sources/repository') return { status: 200, body: { branch: 'main', defaultBranch: 'main', commit: HEAD } }
    if (url.pathname === '/api/instance/sources' && method === 'POST') return { status: 201, body: { entry: { id: 'billing-api', title: 'Billing API', repository: JSON.parse(body).repository }, totalBytes: 0, warning: null } }
    return undefined
  }
  await withClient(
    handler,
    async (gantryClient, fetch) => {
      const result = await tool('add_repository_source_document').handler({ slug: 'ado-instance', provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, folders: ['src'] }, { gantryClient })
      assert.equal(result.isError, undefined, result.content[0].text)
      const check = fetch.calls.find((c) => c.url.pathname === '/api/sources/repository')
      assert.deepEqual(requestBody(check), { action: 'check', repository: { provider: 'github', location: { owner: 'acme', repository: 'billing-api' } } })
      assert.equal(check.headers.authorization, 'Basic ' + Buffer.from(':the-pat').toString('base64'), 'read with the credential this server holds for the workspace')
      const added = fetch.calls.find((c) => c.url.pathname === '/api/instance/sources' && c.method === 'POST')
      assert.deepEqual(requestBody(added), { repository: { ...POINTER, folders: ['src'] } })
      assert.equal(payload(result).commit, HEAD)
    },
    { 'ws-1': 'the-pat' }
  )
})

test('add_repository_source_document passes on gantry serve\'s plain sentence when the repository can\'t be read, and keeps nothing', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/sources/repository') return { status: 403, body: { error: "You can't read the GitHub repository acme/billing-api with the token you gave. Check that it exists and that your token can read it.", code: 'no-access' } }
      return undefined
    },
    async (gantryClient, fetch) => {
      const result = await tool('add_repository_source_document').handler({ slug: 'my-instance', provider: 'github', location: { owner: 'acme', repository: 'billing-api' } }, { gantryClient })
      assert.equal(result.isError, true)
      assert.match(payload(result).error, /^You can't read the GitHub repository acme\/billing-api/)
      assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/sources'), false)
    }
  )
})

test('list_repository_folder, search_repository and read_repository_file read through gantry serve, and a read gives the citation with its commit', async () => {
  await withClient(
    ({ url, body }) => {
      if (url.pathname === '/api/instance/sources') return { status: 200, body: { entries: repositoryEntries, totalBytes: 10, warning: null, limits: {} } }
      if (url.pathname === '/api/sources/repository') {
        const { action, path, query } = JSON.parse(body)
        if (action === 'list') return { status: 200, body: { commit: HEAD, path, entries: [{ path: 'src', isFolder: true }] } }
        if (action === 'search') return { status: 200, body: { commit: HEAD, query, matches: [{ path: 'src/limits.ts', line: 1, text: 'MAX' }], filesSearched: 2, truncated: false } }
        if (action === 'read') return { status: 200, body: { commit: HEAD, path, text: 'x'.repeat(30010), size: 30010, citationQuery: `?path=${path}&commit=${HEAD}` } }
      }
      return undefined
    },
    async (gantryClient, fetch) => {
      const listed = payload(await tool('list_repository_folder').handler({ slug: 'my-instance', id: 'billing-api' }, { gantryClient }))
      assert.deepEqual(listed.entries, [{ path: 'src', isFolder: true }])
      assert.equal(listed.commit, HEAD)
      const asked = fetch.calls.filter((c) => c.url.pathname === '/api/sources/repository').map(requestBody)
      assert.deepEqual(asked[0], { action: 'list', repository: POINTER, path: '' }, 'the pointer comes from the manifest, not the agent')

      const found = payload(await tool('search_repository').handler({ slug: 'my-instance', id: 'billing-api', query: 'MAX' }, { gantryClient }))
      assert.equal(found.matches.length, 1)

      const read = payload(await tool('read_repository_file').handler({ slug: 'my-instance', id: 'billing-api', path: 'src/limits.ts' }, { gantryClient }))
      assert.equal(read.cite, `[Billing API, src/limits.ts](source:billing-api?path=src/limits.ts&commit=${HEAD})`)
      assert.equal(read.text.length, 30000)
      assert.equal(read.next, 30000)
      const rest = payload(await tool('read_repository_file').handler({ slug: 'my-instance', id: 'billing-api', path: 'src/limits.ts', start: 30000 }, { gantryClient }))
      assert.equal(rest.text.length, 10)
      assert.equal(rest.next, undefined)

      const notRepository = await tool('read_repository_file').handler({ slug: 'my-instance', id: 'brief', path: 'x' }, { gantryClient })
      assert.equal(notRepository.isError, true)
      assert.match(payload(notRepository).error, /is not a code repository/)
    }
  )
})

// #338 (docs/adr/0074): the four tools of the in-app AI, with the same options, and a copy still downloading waited through.
test('find_repository_files, and search and read with their new options, pass what the agent asked on to gantry serve', async () => {
  await withClient(
    ({ url, body }) => {
      if (url.pathname === '/api/instance/sources') return { status: 200, body: { entries: repositoryEntries, totalBytes: 10, warning: null, limits: {} } }
      if (url.pathname === '/api/sources/repository') {
        const asked = JSON.parse(body)
        if (asked.action === 'find') return { status: 200, body: { commit: HEAD, pattern: asked.pattern, path: '', paths: ['infra/main.tf'], page: 2, pageSize: 200, total: 201, pages: 2 } }
        if (asked.action === 'search') return { status: 200, body: { commit: HEAD, query: asked.query, regex: true, matches: [{ path: 'src/a.ts', count: 2 }], filesSearched: 9, truncated: false, totalMatches: 2, totalFiles: 1, page: 1, pageSize: 200, total: 1, pages: 1 } }
        if (asked.action === 'read') return { status: 200, body: { commit: HEAD, path: asked.path, text: 'ten\neleven', size: 10, citationQuery: `?path=${asked.path}&commit=${HEAD}`, lines: { from: 10, to: 11, total: 90 } } }
        if (asked.action === 'list') return { status: 200, body: { commit: HEAD, path: asked.path, entries: [], page: 2, pageSize: 200, total: 201, pages: 2 } }
      }
      return undefined
    },
    async (gantryClient, fetch) => {
      const found = payload(await tool('find_repository_files').handler({ slug: 'my-instance', id: 'billing-api', pattern: '**/*.tf', page: 2, commit: HEAD }, { gantryClient }))
      assert.deepEqual([found.paths, found.total, found.pages], [['infra/main.tf'], 201, 2])
      const searched = payload(await tool('search_repository').handler({ slug: 'my-instance', id: 'billing-api', query: 'retry\\w*', regex: true, fileTypes: ['ts'], context: 2, filesOnly: true, path: 'src' }, { gantryClient }))
      assert.equal(searched.totalMatches, 2)
      const read = payload(await tool('read_repository_file').handler({ slug: 'my-instance', id: 'billing-api', path: 'src/a.ts', lines: '10-11' }, { gantryClient }))
      assert.deepEqual(read.lines, { from: 10, to: 11, total: 90 })
      assert.equal(read.text, 'ten\neleven')
      await tool('list_repository_folder').handler({ slug: 'my-instance', id: 'billing-api', path: 'src', page: 2 }, { gantryClient })
      await tool('search_repository').handler({ slug: 'my-instance', id: 'billing-api', query: 'retry', page: 2, commit: HEAD }, { gantryClient })

      const asked = fetch.calls.filter((c) => c.url.pathname === '/api/sources/repository').map(requestBody)
      assert.deepEqual(asked, [
        { action: 'find', repository: POINTER, pattern: '**/*.tf', path: '', page: 2, commit: HEAD },
        { action: 'search', repository: POINTER, query: 'retry\\w*', path: 'src', regex: true, fileTypes: ['ts'], context: 2, filesOnly: true },
        { action: 'read', repository: POINTER, path: 'src/a.ts', lines: '10-11' },
        { action: 'list', repository: POINTER, path: 'src', page: 2 },
        { action: 'search', repository: POINTER, query: 'retry', path: '', page: 2, commit: HEAD },
      ])
      for (const name of ['find_repository_files', 'search_repository', 'list_repository_folder']) assert.ok(tool(name).inputSchema.commit, `${name} takes the commit of the page before`)
      const names = tools.map((t) => t.name)
      assert.ok(names.indexOf('find_repository_files') < names.indexOf('search_repository'))
      assert.match(tool('search_repository').description, /contents only: to find files by name, use find_repository_files/)
      assert.match(tool('find_repository_files').description, /names only: to search what files contain, use search_repository/)
    }
  )
})

test('a copy gantry serve is still preparing (202) is asked again until it is ready, so the agent\'s call resolves with the result', async () => {
  let preparing = 2
  await withClient(
    ({ url, body }) => {
      if (url.pathname === '/api/instance/sources') return { status: 200, body: { entries: repositoryEntries, totalBytes: 10, warning: null, limits: {} } }
      if (url.pathname === '/api/sources/repository') {
        if (preparing-- > 0) return { status: 202, body: { preparing: true, commit: HEAD, receivedBytes: 1024, repository: 'acme/billing-api' } }
        return { status: 200, body: { commit: HEAD, query: JSON.parse(body).query, matches: [], filesSearched: 4, truncated: false, totalMatches: 0, totalFiles: 0, page: 1, pageSize: 50, total: 0, pages: 0 } }
      }
      return undefined
    },
    async (gantryClient, fetch) => {
      const result = await tool('search_repository').handler({ slug: 'my-instance', id: 'billing-api', query: 'MAX' }, { gantryClient, repositoryPollMs: 0 })
      assert.equal(result.isError, undefined)
      assert.equal(payload(result).totalMatches, 0)
      const asked = fetch.calls.filter((c) => c.url.pathname === '/api/sources/repository').map(requestBody)
      assert.equal(asked.length, 3, 'asked until the copy was ready')
      assert.equal(asked[0].commit, undefined)
      assert.deepEqual(asked.slice(1).map((body) => body.commit), [HEAD, HEAD], 'asked again at the commit being prepared, so a branch that moves meanwhile starts no second download')
    }
  )
})

test('a call the agent cancels while a copy is preparing stops asking gantry serve', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/sources') return { status: 200, body: { entries: repositoryEntries, totalBytes: 10, warning: null, limits: {} } }
      if (url.pathname === '/api/sources/repository') return { status: 202, body: { preparing: true, commit: HEAD, receivedBytes: 0, repository: 'acme/billing-api' } }
      return undefined
    },
    async (gantryClient, fetch) => {
      const stop = new AbortController()
      const asking = tool('search_repository').handler({ slug: 'my-instance', id: 'billing-api', query: 'MAX' }, { gantryClient, repositoryPollMs: 20, signal: stop.signal })
      await new Promise((resolve) => setTimeout(resolve, 50))
      stop.abort()
      const result = await asking
      assert.equal(result.isError, true)
      assert.equal(payload(result).detail.code, 'abandoned')
      const after = fetch.calls.length
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.equal(fetch.calls.length, after, 'nothing more is asked once cancelled')
    }
  )
})

// ---------------------------------------------------------------------------
// Source documents
// ---------------------------------------------------------------------------

test('list_source_documents lists the documents and marks which are replaced, removed or without text', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/sources') {
        return {
          status: 200,
          body: {
            entries: [
              { id: 'brief', filename: 'brief.docx', title: 'Brief', size: 10, text: 'sources/.text/brief.docx.md' },
              { id: 'brief-v2', filename: 'brief-v2.docx', title: 'Brief v2', size: 12, replaces: 'brief', text: 'sources/.text/brief-v2.docx.md' },
              { id: 'old', filename: 'old.pdf', title: 'Old', size: 3, removedAt: '2026-11-01T00:00:00Z' },
              { id: 'scan', filename: 'scan.pdf', title: 'Scan', size: 3 },
            ],
            totalBytes: 25,
            warning: null,
            limits: { maxBytes: 26214400 },
          },
        }
      }
      return undefined
    },
    async (gantryClient, fetch) => {
      const result = await tool('list_source_documents').handler({ slug: 'my-instance' }, { gantryClient })
      assert.equal(result.isError, undefined)
      const { documents, totalBytes, limits } = payload(result)
      assert.equal(totalBytes, 25)
      assert.equal(limits.maxBytes, 26214400)
      const byId = Object.fromEntries(documents.map((d) => [d.id, d]))
      assert.equal(byId.brief.replacedBy, 'brief-v2')
      assert.equal(byId.brief.hasText, true)
      assert.equal(byId['brief-v2'].replaces, 'brief')
      assert.equal('replacedBy' in byId['brief-v2'], false)
      assert.equal(byId.old.removed, true)
      assert.equal(byId.scan.hasText, false)
      const call = fetch.calls.find((c) => c.url.pathname === '/api/instance/sources')
      assert.equal(call.url.searchParams.get('slug'), 'my-instance')
      assert.equal(call.url.searchParams.get('scope'), 'scope-1')
    }
  )
})

test('list_source_documents attaches the mapped PAT for a Provider-backed instance, and reports a missing one', async () => {
  const handler = ({ url, headers }) => {
    if (url.pathname === '/api/instance/sources') return { status: 200, body: { entries: [], totalBytes: 0, warning: null, limits: {} }, auth: headers.authorization }
    return undefined
  }
  await withClient(
    handler,
    async (gantryClient, fetch) => {
      const result = await tool('list_source_documents').handler({ slug: 'ado-instance' }, { gantryClient })
      assert.equal(result.isError, undefined)
      const call = fetch.calls.find((c) => c.url.pathname === '/api/instance/sources')
      assert.equal(call.headers.authorization, 'Basic ' + Buffer.from(':the-pat').toString('base64'))
    },
    { 'ws-1': 'the-pat' }
  )
  await withClient(handler, async (gantryClient, fetch) => {
    const result = await tool('list_source_documents').handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    assert.equal(payload(result).error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/sources'), false)
  })
})

test('read_source_document asks for a page and returns the text, page and page count', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/sources/plan/content') {
        return { status: 200, body: { entry: { id: 'plan', title: 'Plan' }, kind: 'pdf', by: 'pdf-page', page: Number(url.searchParams.get('page')), pageCount: 6, text: 'Budget NZD 1.2m' } }
      }
      return undefined
    },
    async (gantryClient, fetch) => {
      const result = await tool('read_source_document').handler({ slug: 'my-instance', id: 'plan', page: 4 }, { gantryClient })
      const body = payload(result)
      assert.equal(body.page, 4)
      assert.equal(body.pageCount, 6)
      assert.equal(body.text, 'Budget NZD 1.2m')
      assert.equal(fetch.calls.find((c) => c.url.pathname.endsWith('/content')).url.searchParams.get('page'), '4')
    }
  )
})

test('read_source_document returns a picture as an image block', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/sources/diagram/content') {
        return { status: 200, body: { entry: { id: 'diagram', title: 'Diagram' }, kind: 'image', image: { mimeType: 'image/png', dataBase64: 'iVBORw0KGgo=' } } }
      }
      return undefined
    },
    async (gantryClient) => {
      const result = await tool('read_source_document').handler({ slug: 'my-instance', id: 'diagram' }, { gantryClient })
      assert.equal(result.isError, undefined)
      assert.equal(result.content.length, 2)
      assert.equal(result.content[0].type, 'text')
      const meta = JSON.parse(result.content[0].text)
      assert.equal(meta.kind, 'image')
      assert.equal('image' in meta, false, 'the bytes are in the image block, not repeated in the JSON')
      assert.deepEqual(result.content[1], { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' })
    }
  )
})

test('read_source_document needs an id and surfaces a removed or missing document', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/sources/gone/content') return { status: 409, body: { error: '"Gone" has been removed.', code: 'removed' } }
      return undefined
    },
    async (gantryClient) => {
      const noId = await tool('read_source_document').handler({ slug: 'my-instance' }, { gantryClient })
      assert.equal(noId.isError, true)
      const gone = await tool('read_source_document').handler({ slug: 'my-instance', id: 'gone' }, { gantryClient })
      assert.equal(gone.isError, true)
      assert.match(payload(gone).detail.error, /has been removed/)
    }
  )
})

test('upload_source_document sends the bytes with extractText so gantry serve reads the document', async () => {
  await withClient(
    ({ url, method, body }) => {
      if (url.pathname === '/api/instance/sources' && method === 'POST') {
        const sent = JSON.parse(body)
        return { status: 201, body: { entry: { id: 'client-brief', filename: sent.filename, replaces: sent.replaces }, extraction: { read: true, note: 'The text was read from it.' } } }
      }
      return undefined
    },
    async (gantryClient, fetch) => {
      const bytes = Buffer.from('word bytes')
      const result = await tool('upload_source_document').handler(
        { slug: 'my-instance', filename: 'Client brief.docx', contentBase64: `data:application/octet-stream;base64,${bytes.toString('base64')}`, uploadedBy: 'an.agent', replaces: 'older' },
        { gantryClient }
      )
      assert.equal(result.isError, undefined)
      assert.equal(payload(result).extraction.read, true)
      const call = fetch.calls.find((c) => c.url.pathname === '/api/instance/sources')
      const sent = JSON.parse(call.body)
      assert.deepEqual(sent, { filename: 'Client brief.docx', dataBase64: bytes.toString('base64'), extractText: true, uploadedBy: 'an.agent', replaces: 'older' })
      assert.equal(call.url.searchParams.get('slug'), 'my-instance')
    }
  )
})

test('upload_source_document surfaces a refusal (a type Gantry does not take, 25 MB) with gantry serve\'s own message', async () => {
  await withClient(
    ({ url, method }) => {
      if (url.pathname === '/api/instance/sources' && method === 'POST') return { status: 400, body: { error: "Gantry can't take .html files. It takes Word (.docx)...", code: 'unsupported-type' } }
      return undefined
    },
    async (gantryClient) => {
      const result = await tool('upload_source_document').handler({ slug: 'my-instance', filename: 'page.html', contentBase64: 'PHA+' }, { gantryClient })
      assert.equal(result.isError, true)
      assert.match(payload(result).detail.error, /can't take \.html files/)
    }
  )
})

test('upload_source_document checks its own arguments before calling gantry serve', async () => {
  await withClient(
    () => {
      throw new Error('should not be called')
    },
    async (gantryClient, fetch) => {
      assert.equal((await tool('upload_source_document').handler({ slug: 's', contentBase64: 'AAAA' }, { gantryClient })).isError, true)
      assert.equal((await tool('upload_source_document').handler({ slug: 's', filename: 'a.pdf' }, { gantryClient })).isError, true)
      assert.equal((await tool('upload_source_document').handler({ slug: 's', filename: 'a.pdf', contentBase64: '!!!' }, { gantryClient })).isError, true)
      assert.equal(fetch.calls.length, 0)
    }
  )
})

// ---------------------------------------------------------------------------
// Source documents from a web address (#318)
// ---------------------------------------------------------------------------

const FETCHED = {
  address: 'https://vendor.example.com/api',
  finalAddress: 'https://docs.vendor.example.com/api',
  fetchedAt: '2026-11-03T09:00:00.000Z',
  contentType: 'text/html',
  filename: 'Vendor API guide.html',
  title: 'Vendor API guide',
  size: 10,
  dataBase64: Buffer.from('<p>page</p>').toString('base64'),
}

test('add_source_document_from_address has gantry serve fetch the address, then adds it like an upload with its origin', async () => {
  await withClient(
    ({ url, method, body }) => {
      if (url.pathname === '/api/sources/fetch' && method === 'POST') return { status: 200, body: { ...FETCHED, address: JSON.parse(body).address } }
      if (url.pathname === '/api/instance/sources' && method === 'POST') {
        const sent = JSON.parse(body)
        return { status: 201, body: { entry: { id: 'vendor-api-guide', filename: sent.filename, title: sent.title, origin: sent.origin }, extraction: { read: true, note: 'The text was read from it.' } } }
      }
      return undefined
    },
    async (gantryClient, fetch) => {
      const result = await tool('add_source_document_from_address').handler({ slug: 'my-instance', address: 'https://vendor.example.com/api', uploadedBy: 'an.agent' }, { gantryClient })
      assert.equal(result.isError, undefined)
      assert.deepEqual(payload(result).entry.origin, { address: FETCHED.address, finalAddress: FETCHED.finalAddress, fetchedAt: FETCHED.fetchedAt })
      const fetchCall = fetch.calls.find((c) => c.url.pathname === '/api/sources/fetch')
      assert.deepEqual(JSON.parse(fetchCall.body), { address: 'https://vendor.example.com/api' })
      assert.equal(fetchCall.headers.authorization, undefined, 'the fetch carries no workspace credential')
      const sent = JSON.parse(fetch.calls.find((c) => c.url.pathname === '/api/instance/sources').body)
      assert.deepEqual(sent, {
        filename: 'Vendor API guide.html',
        dataBase64: FETCHED.dataBase64,
        extractText: true,
        title: 'Vendor API guide',
        origin: { address: FETCHED.address, finalAddress: FETCHED.finalAddress, fetchedAt: FETCHED.fetchedAt },
        uploadedBy: 'an.agent',
      })
    }
  )
})

test('add_source_document_from_address passes on gantry serve\'s own sentence for a refused or failed fetch, and stores nothing', async () => {
  for (const [status, error, code] of [
    [400, "Gantry won't fetch 10.0.0.5: it is a private or loopback address...", 'address-refused'],
    [422, 'https://wiki.example.com needs a sign-in... save it as a PDF and upload that instead.', 'sign-in'],
    [413, 'https://example.com/big.pdf is over the 25 MB limit for a Source document.', 'too-large'],
    [403, 'Adding Source documents by web address is switched off on this Gantry server.', 'source-fetch-off'],
  ]) {
    await withClient(
      ({ url }) => (url.pathname === '/api/sources/fetch' ? { status, body: { error, code } } : undefined),
      async (gantryClient, fetch) => {
        const result = await tool('add_source_document_from_address').handler({ slug: 'my-instance', address: 'https://example.com/x' }, { gantryClient })
        assert.equal(result.isError, true)
        assert.equal(payload(result).error, error)
        assert.equal(payload(result).detail.code, code)
        assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/sources'), false)
      }
    )
  }
})

test('fetch_source_document_again fetches the document\'s own address and reports an unchanged page or a replacement', async () => {
  const listed = {
    entries: [
      { id: 'vendor-api-guide', title: 'Vendor API guide', filename: 'Vendor API guide.html', origin: { address: FETCHED.address, finalAddress: FETCHED.finalAddress, fetchedAt: '2026-11-01T00:00:00.000Z' } },
      { id: 'brief', title: 'Brief', filename: 'brief.docx' },
    ],
  }
  for (const unchanged of [true, false]) {
    await withClient(
      ({ url, method, body }) => {
        if (url.pathname === '/api/instance/sources' && method === 'GET') return { status: 200, body: listed }
        if (url.pathname === '/api/sources/fetch' && method === 'POST') return { status: 200, body: { ...FETCHED, address: JSON.parse(body).address } }
        if (url.pathname === '/api/instance/sources/vendor-api-guide/fetch-again' && method === 'POST') {
          return unchanged
            ? { status: 200, body: { unchanged: true, entry: listed.entries[0] } }
            : { status: 201, body: { unchanged: false, entry: { id: 'vendor-api-guide-2', replaces: 'vendor-api-guide', origin: JSON.parse(body).origin } } }
        }
        return undefined
      },
      async (gantryClient, fetch) => {
        const result = await tool('fetch_source_document_again').handler({ slug: 'my-instance', id: 'vendor-api-guide' }, { gantryClient })
        assert.equal(result.isError, undefined)
        assert.equal(JSON.parse(fetch.calls.find((c) => c.url.pathname === '/api/sources/fetch').body).address, FETCHED.address)
        const sent = JSON.parse(fetch.calls.find((c) => c.url.pathname.endsWith('/fetch-again')).body)
        assert.equal(sent.extractText, true)
        assert.equal(sent.origin.fetchedAt, FETCHED.fetchedAt)
        if (unchanged) {
          assert.equal(payload(result).unchanged, true)
          assert.match(payload(result).note, /Unchanged since 2026-11-01T00:00:00\.000Z: nothing was added/)
        } else {
          assert.equal(payload(result).entry.replaces, 'vendor-api-guide')
          assert.match(payload(result).note, /flagged Out of date/)
        }
      }
    )
  }
  await withClient(
    ({ url, method }) => (url.pathname === '/api/instance/sources' && method === 'GET' ? { status: 200, body: listed } : undefined),
    async (gantryClient, fetch) => {
      const result = await tool('fetch_source_document_again').handler({ slug: 'my-instance', id: 'brief' }, { gantryClient })
      assert.equal(result.isError, true)
      assert.match(payload(result).error, /uploaded, not fetched/)
      assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/sources/fetch'), false)
    }
  )
})

test('fetch_source_document_again refuses an older copy that has already been replaced, as the app does, without fetching anything', async () => {
  const origin = (fetchedAt) => ({ address: FETCHED.address, finalAddress: FETCHED.finalAddress, fetchedAt })
  const listed = {
    entries: [
      { id: 'vendor-api-guide', title: 'Vendor API guide', filename: 'Vendor API guide.html', uploadedAt: '2026-11-01T00:00:00.000Z', origin: origin('2026-11-01T00:00:00.000Z') },
      { id: 'vendor-api-guide-2', title: 'Vendor API guide', filename: 'Vendor API guide-2.html', uploadedAt: '2026-11-02T00:00:00.000Z', origin: origin('2026-11-02T00:00:00.000Z'), replaces: 'vendor-api-guide' },
    ],
  }
  await withClient(
    ({ url, method }) => (url.pathname === '/api/instance/sources' && method === 'GET' ? { status: 200, body: listed } : undefined),
    async (gantryClient, fetch) => {
      const result = await tool('fetch_source_document_again').handler({ slug: 'my-instance', id: 'vendor-api-guide' }, { gantryClient })
      assert.equal(result.isError, true)
      assert.match(payload(result).error, /"Vendor API guide" \(vendor-api-guide\) has already been replaced by "Vendor API guide" \(vendor-api-guide-2\)\. Fetch again the newest copy instead/)
      assert.equal(payload(result).detail.code, 'replaced')
      assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/sources/fetch'), false, 'nothing was fetched')
      assert.equal(fetch.calls.some((c) => c.url.pathname.endsWith('/fetch-again')), false, 'nothing was sent')
    }
  )
  // gantry serve's own refusal (another caller replaced it between the list and the call) comes back as it said it.
  await withClient(
    ({ url, method }) => {
      if (url.pathname === '/api/instance/sources' && method === 'GET') return { status: 200, body: { entries: [listed.entries[0]] } }
      if (url.pathname === '/api/sources/fetch' && method === 'POST') return { status: 200, body: FETCHED }
      if (url.pathname === '/api/instance/sources/vendor-api-guide/fetch-again') return { status: 409, body: { error: '"Vendor API guide" (vendor-api-guide) has already been replaced by "Vendor API guide" (vendor-api-guide-2).', code: 'replaced' } }
      return undefined
    },
    async (gantryClient) => {
      const result = await tool('fetch_source_document_again').handler({ slug: 'my-instance', id: 'vendor-api-guide' }, { gantryClient })
      assert.equal(result.isError, true)
      assert.match(JSON.stringify(payload(result)), /already been replaced/)
    }
  )
})

test('the add-by-address tools are offered only when gantry serve says adding by address is on', async () => {
  for (const tool of tools.filter((t) => ['add_source_document_from_address', 'fetch_source_document_again'].includes(t.name))) assert.equal(tool.available, sourceFetchOffered)
  for (const [answer, offered] of [[{ status: 200, body: { enabled: true } }, true], [{ status: 200, body: { enabled: false } }, false], [{ status: 404, body: {} }, false]]) {
    await withClient(
      ({ url }) => (url.pathname === '/api/sources/fetch' ? answer : undefined),
      async (gantryClient) => {
        assert.equal(await sourceFetchOffered({ gantryClient }), offered)
      }
    )
  }
  await withClient(
    () => {
      throw new Error('gantry serve is down')
    },
    async (gantryClient) => assert.equal(await sourceFetchOffered({ gantryClient }), false)
  )
})

// ---------------------------------------------------------------------------
// Decisions logs
// ---------------------------------------------------------------------------

test('read_decisions_log reads the current stage\'s log, or the stage asked for', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/decisions') return { status: 200, body: { log: { stage: url.searchParams.get('stage') ?? 'current', entries: [{ id: 'd1', kind: 'decision', text: 'Use Postgres' }], fields: {} } } }
      return undefined
    },
    async (gantryClient, fetch) => {
      const current = payload(await tool('read_decisions_log').handler({ slug: 'my-instance' }, { gantryClient }))
      assert.equal(current.log.stage, 'current')
      const shape = payload(await tool('read_decisions_log').handler({ slug: 'my-instance', stage: 'shape' }, { gantryClient }))
      assert.equal(shape.log.stage, 'shape')
      assert.equal(shape.log.entries[0].text, 'Use Postgres')
      assert.equal(fetch.calls.filter((c) => c.url.pathname === '/api/instance/decisions').at(-1).url.searchParams.get('stage'), 'shape')
    }
  )
})

test('read_decisions_log with allStages reads every stage\'s log in stage order', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance') return { status: 200, body: { stages: [{ id: 'shape', title: 'Shape' }, { id: 'design', title: 'Design' }] } }
      if (url.pathname === '/api/instance/decisions') return { status: 200, body: { log: { stage: url.searchParams.get('stage'), entries: [] } } }
      return undefined
    },
    async (gantryClient) => {
      const { logs } = payload(await tool('read_decisions_log').handler({ slug: 'my-instance', allStages: true }, { gantryClient }))
      assert.deepEqual(logs.map((l) => [l.stage, l.title, l.log.stage]), [['shape', 'Shape', 'shape'], ['design', 'Design', 'design']])
    }
  )
})

test('read_decisions_log surfaces the 400 a GitLab or Atlassian workspace answers', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/decisions') return { status: 400, body: { error: 'The decisions log is kept for local, server, Azure DevOps and GitHub workspaces so far.' } }
      return undefined
    },
    async (gantryClient) => {
      const result = await tool('read_decisions_log').handler({ slug: 'my-instance' }, { gantryClient })
      assert.equal(result.isError, true)
      assert.match(payload(result).detail.error, /GitHub workspaces so far/)
    }
  )
})

// ---------------------------------------------------------------------------
// Reviewed copies
// ---------------------------------------------------------------------------

test('list_reviewed_copies lists the manifest entries', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/reviews') return { status: 200, body: { reviews: [{ id: 'abc', name: 'HLD.docx', comments: 9 }] } }
      return undefined
    },
    async (gantryClient) => {
      const { reviewedCopies } = payload(await tool('list_reviewed_copies').handler({ slug: 'my-instance' }, { gantryClient }))
      assert.deepEqual(reviewedCopies, [{ id: 'abc', name: 'HLD.docx', comments: 9 }])
    }
  )
})

test('read_reviewed_copy returns the threads grouped by the Field they trace to', async () => {
  const groups = [{ kind: 'field', field: { key: 'background.problem', fieldTitle: 'Problem statement' }, threads: [{ author: 'Ana', text: 'Which card schemes?', resolved: false, replies: [] }], changes: [] }]
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/reviews/abc') return { status: 200, body: { entry: { id: 'abc' }, mode: 'bookmarks', notice: null, groups } }
      return undefined
    },
    async (gantryClient) => {
      const result = await tool('read_reviewed_copy').handler({ slug: 'my-instance', id: 'abc' }, { gantryClient })
      assert.deepEqual(payload(result).groups, groups)
      assert.equal((await tool('read_reviewed_copy').handler({ slug: 'my-instance' }, { gantryClient })).isError, true)
    }
  )
})

test('upload_reviewed_copy sends the files in one request and returns the entries added', async () => {
  await withClient(
    ({ url, method, body }) => {
      if (url.pathname === '/api/instance/reviews' && method === 'POST') return { status: 201, body: { reviews: JSON.parse(body).files.map((f, i) => ({ id: `id-${i}`, name: f.filename })) } }
      return undefined
    },
    async (gantryClient, fetch) => {
      const result = await tool('upload_reviewed_copy').handler(
        { slug: 'my-instance', files: [{ filename: 'HLD.docx', contentBase64: Buffer.from('one').toString('base64') }, { filename: 'SAD.docx', contentBase64: Buffer.from('two').toString('base64') }] },
        { gantryClient }
      )
      assert.deepEqual(payload(result).reviewedCopies.map((r) => r.name), ['HLD.docx', 'SAD.docx'])
      const post = fetch.calls.filter((c) => c.url.pathname === '/api/instance/reviews')
      assert.equal(post.length, 1)
      assert.deepEqual(JSON.parse(post[0].body).files.map((f) => f.dataBase64), [Buffer.from('one').toString('base64'), Buffer.from('two').toString('base64')])
    }
  )
})

test('upload_reviewed_copy refuses an untagged document with gantry serve\'s own message', async () => {
  const message = "plain.docx: This document wasn't rendered by Gantry: it has none of the gantry-* properties a Gantry render carries. Upload it as a Source document instead."
  await withClient(
    ({ url, method }) => {
      if (url.pathname === '/api/instance/reviews' && method === 'POST') return { status: 422, body: { error: message, files: [{ filename: 'plain.docx', ok: false, code: 'untagged' }] } }
      return undefined
    },
    async (gantryClient) => {
      const result = await tool('upload_reviewed_copy').handler({ slug: 'my-instance', files: [{ filename: 'plain.docx', contentBase64: 'AAAA' }] }, { gantryClient })
      assert.equal(result.isError, true)
      assert.equal(payload(result).detail.error, message)
      assert.equal(payload(result).detail.files[0].code, 'untagged')
    }
  )
})

test('upload_reviewed_copy checks its arguments before calling gantry serve', async () => {
  await withClient(
    () => {
      throw new Error('should not be called')
    },
    async (gantryClient, fetch) => {
      assert.equal((await tool('upload_reviewed_copy').handler({ slug: 's' }, { gantryClient })).isError, true)
      assert.equal((await tool('upload_reviewed_copy').handler({ slug: 's', files: [] }, { gantryClient })).isError, true)
      assert.equal((await tool('upload_reviewed_copy').handler({ slug: 's', files: [{ filename: 'a.docx' }] }, { gantryClient })).isError, true)
      assert.equal(fetch.calls.length, 0)
    }
  )
})

// ---------------------------------------------------------------------------
// get_instance: Out of date Fields
// ---------------------------------------------------------------------------

const getInstance = instanceTools.find((t) => t.name === 'get_instance')

test('get_instance reports the Fields that are Out of date beside the instance', async () => {
  const outOfDate = {
    supported: true,
    fields: [{ field: 'background.problem', title: 'Background · Problem', note: 'Out of date: Brief was replaced by Brief v2', flags: [{ cause: 'source', change: 'replaced', source: 'brief' }] }],
    summary: ['1 Field drew on Brief, now replaced by Brief v2'],
    newSinceLastInterview: [],
  }
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance') return { status: 200, body: { slug: 'my-instance', stageVersion: 'v1' } }
      if (url.pathname === '/api/instance/out-of-date') return { status: 200, body: outOfDate }
      return undefined
    },
    async (gantryClient, fetch) => {
      const body = payload(await getInstance.handler({ slug: 'my-instance' }, { gantryClient }))
      assert.equal(body.stageVersion, 'v1')
      assert.deepEqual(body.outOfDate, outOfDate)
      assert.equal(fetch.calls.find((c) => c.url.pathname === '/api/instance/out-of-date').url.searchParams.get('slug'), 'my-instance')
    }
  )
  assert.match(getInstance.description, /"outOfDate"/)
})

test('get_instance still answers when the Out of date check fails, and says so', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance') return { status: 200, body: { slug: 'my-instance' } }
      if (url.pathname === '/api/instance/out-of-date') return { status: 500, body: { error: 'boom' } }
      return undefined
    },
    async (gantryClient) => {
      const result = await getInstance.handler({ slug: 'my-instance' }, { gantryClient })
      assert.equal(result.isError, undefined)
      const body = payload(result)
      assert.equal(body.slug, 'my-instance')
      assert.equal(body.outOfDateError, 'boom')
      assert.equal('outOfDate' in body, false)
    }
  )
})
