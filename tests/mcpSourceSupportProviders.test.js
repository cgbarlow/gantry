import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RENDER_PROPERTIES, reviewedCopy } from './helpers/reviewedCopyFixture.js'
import { basicAuthHeader, withRunningServerForProvider, withScratchInstances } from './helpers/lifecycle.js'

// #305 (docs/adr/0067): the same routes as tests/mcpSourceSupport.test.js, on Azure DevOps and GitHub workspaces, where every change is a
// commit on the current Stage's branch and the saved content and Source documents are read from it.

const SLUG = 'acme'
const b64 = (bytes) => Buffer.from(bytes).toString('base64')

const PROVIDERS = [
  { name: 'Azure DevOps', provider: 'azure-devops', serverOptions: { allowAzureDevOpsBaseUrlOverride: true }, location: (ctx) => ({ azureDevOps: { organization: ctx.organization, project: ctx.project, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }) },
  { name: 'GitHub', provider: 'github', serverOptions: {}, location: (ctx) => ({ github: { owner: ctx.owner, repository: ctx.repository, baseUrl: ctx.providerBaseUrl } }) },
]

for (const { name, provider, serverOptions, location } of PROVIDERS) {
  test(`${name}-backed: an MCP-style upload is read on the server and by page, flagged Out of date when replaced, and a Reviewed copy is read by Field`, () =>
    withScratchInstances((instancesDir) =>
      withRunningServerForProvider(provider, { options: { instancesDir, ...serverOptions } }, async (ctx) => {
        const auth = { Authorization: basicAuthHeader(ctx.pat) }
        const api = (method, path, body) =>
          fetch(`${ctx.gantryBase}${path}${path.includes('?') ? '&' : '?'}slug=${SLUG}`, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body === undefined ? undefined : JSON.stringify(body) })
        const created = await fetch(`${ctx.gantryBase}/api/instances`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify({ definition: 'design', slug: SLUG, ...location(ctx) }) })
        assert.equal(created.status, 201, await created.clone().text())

        const uploaded = await api('POST', '/api/instance/sources', { filename: 'Client brief.txt', dataBase64: b64('Five thousand users, by March.'), extractText: true, uploadedBy: 'an.agent' })
        assert.equal(uploaded.status, 201, await uploaded.clone().text())
        assert.deepEqual((await uploaded.json()).extraction, { read: true, note: 'The text was read from it.' })
        const content = await (await api('GET', '/api/instance/sources/client-brief/content')).json()
        assert.equal(content.text, 'Five thousand users, by March.')
        assert.equal(content.pageCount, 1)

        const instance = await (await api('GET', '/api/instance')).json()
        const moduleId = instance.modules[0].id
        const fieldId = instance.modules[0].fields[0].id
        const saved = await api('PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [fieldId]: 'Expect 5000 users ([Client brief, p. 1](source:client-brief)).' } } } })
        assert.equal(saved.status, 200, await saved.clone().text())
        assert.deepEqual((await (await api('GET', '/api/instance/out-of-date')).json()).fields, [])

        // A Field the AI drafted from the document, per the Stage's decisions log (kept on the Stage's own branch), is flagged as well.
        const otherFieldId = instance.modules[0].fields[1].id
        const otherKey = `${moduleId}.${otherFieldId}`
        assert.equal((await api('PUT', '/api/instance/modules', { modules: { [moduleId]: { fields: { [fieldId]: 'Expect 5000 users ([Client brief, p. 1](source:client-brief)).', [otherFieldId]: 'Drafted from the brief.' } } } })).status, 200)
        const logged = await api('PUT', `/api/instance/decisions?stage=${instance.stage.id}`, { decisions: { fields: { [otherKey]: { drafted: '2026-11-01T09:00:00.000Z', inputs: [{ source: 'client-brief' }] } } } })
        assert.equal(logged.status, 200, await logged.clone().text())
        assert.deepEqual((await (await api('GET', `/api/instance/decisions?stage=${instance.stage.id}`)).json()).log.fields[otherKey].inputs[0].source, 'client-brief')

        assert.equal((await api('POST', '/api/instance/sources', { filename: 'Client brief v2.txt', dataBase64: b64('Eight thousand users.'), extractText: true, replaces: 'client-brief' })).status, 201)
        const flagged = await (await api('GET', '/api/instance/out-of-date')).json()
        assert.deepEqual(flagged.fields.map((f) => [f.field, f.flags[0].change]).sort(), [[`${moduleId}.${fieldId}`, 'replaced'], [otherKey, 'replaced']].sort())

        const copy = await api('POST', '/api/instance/reviews', { files: [{ filename: 'HLD.docx', dataBase64: b64(reviewedCopy({ properties: { ...RENDER_PROPERTIES, instance: SLUG } })) }] })
        assert.equal(copy.status, 201, await copy.clone().text())
        const [entry] = (await copy.json()).reviews
        const read = await api('GET', `/api/instance/reviews/${entry.id}`)
        assert.equal(read.status, 200, await read.clone().text())
        const groups = (await read.json()).groups
        assert.ok(groups.some((g) => g.kind === 'field' && g.field.key === 'background.problem' && g.threads.some((t) => t.text === 'Which card schemes?')))
      })
    ))
}
