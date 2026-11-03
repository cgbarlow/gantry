import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient } from '../src/gantryClient.js'
import { tools } from '../src/tools/sourceDocuments.tools.js'
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
  const names = ['list_source_documents', 'read_source_document', 'upload_source_document', 'read_decisions_log', 'list_reviewed_copies', 'read_reviewed_copy', 'upload_reviewed_copy']
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
