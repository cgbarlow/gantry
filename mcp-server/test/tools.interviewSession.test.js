import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient } from '../src/gantryClient.js'
import { tools } from '../src/tools/interviewSession.tools.js'
import { tools as instanceTools } from '../src/tools/instanceContent.tools.js'
import { tools as stageTools } from '../src/tools/stageLifecycle.tools.js'
import { stubFetch } from './helpers/fakeFetch.js'

// #307 (docs/adr/0067): an outside agent running an AI interview session. Every test mocks at the HTTP seam; the routes themselves
// (the brief, the labelled entries, the guard rails) are tested against a real `gantry serve` in the main package
// (tests/outsideAgentRoutes.test.js, tests/outsideAgentProviders.test.js).

const BASE_URL = 'https://gantry.example.test'
const tool = (name) => tools.find((t) => t.name === name)
const instanceTool = (name) => instanceTools.find((t) => t.name === name)
const stageTool = (name) => stageTools.find((t) => t.name === name)
const payload = (result) => JSON.parse(result.content[0].text)

const INSTANCE = {
  stage: { id: 'shape', title: 'Shape' },
  currentStageId: 'shape',
  stages: [
    { id: 'shape', title: 'Shape' },
    { id: 'design', title: 'Design' },
  ],
  stageVersion: 'aaaaaaaaaaaaaaaa',
  workspaceBacked: false,
}
const BRIEF = {
  stage: { id: 'shape', title: 'Shape', gate: 'g1' },
  brief: '## 1. Gantry\'s interview rules\n...',
  parts: [{ order: 1, id: 'rules' }],
  recap: { resuming: false, line: 'Starting Shape: nothing is logged for this Stage yet.', sessions: [], adoptable: null, others: [] },
  heldModules: [],
  instructions: 'You are an outside agent...',
}

function route(extra) {
  return (call) => {
    const { url } = call
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: url.searchParams.get('slug') === 'ado-instance' ? 'ws-1' : 'srv-1', scope: 'scope-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: 'ws-1', provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1' }] }
    return extra(call)
  }
}

async function withClient(handler, fn, workspacePats = {}) {
  const fetch = stubFetch(route(handler))
  try {
    return await fn(createGantryClient({ baseUrl: BASE_URL, workspacePats }), fetch)
  } finally {
    fetch.restore()
  }
}

test('the cluster registers its tools with the instance addressing arguments', () => {
  assert.deepEqual(tools.map((t) => t.name), ['get_interview_brief', 'start_interview_session', 'pause_interview_session', 'resume_interview_session', 'get_review_response_list', 'record_review_answers'])
  for (const t of tools) for (const key of ['slug', 'scope', 'ref']) assert.ok(t.inputSchema[key], `${t.name} takes ${key}`)
})

test('every tool refuses a call with neither slug nor ref, without touching the network', async () => {
  await withClient(
    () => {
      throw new Error('should not be called')
    },
    async (gantryClient, fetch) => {
      for (const t of tools) {
        const result = await t.handler({ session: { id: 's-1' }, answered: { r1: 1 } }, { gantryClient })
        assert.equal(result.isError, true, t.name)
        assert.match(payload(result).error, /slug.*ref/, t.name)
      }
      assert.equal(fetch.calls.length, 0)
    }
  )
})

test('get_interview_brief returns the server\'s brief and recap with the stage version to save against', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance') return { status: 200, body: INSTANCE }
      if (url.pathname === '/api/instance/interview-brief') {
        assert.equal(url.searchParams.get('stage'), 'shape', 'the current stage when none is named')
        assert.equal(url.searchParams.get('who'), 'a.architect')
        return { status: 200, body: BRIEF }
      }
      return undefined
    },
    async (gantryClient) => {
      const result = await tool('get_interview_brief').handler({ slug: 'my-instance', who: 'a.architect' }, { gantryClient })
      const body = payload(result)
      assert.equal(body.stageVersion, 'aaaaaaaaaaaaaaaa')
      assert.equal(body.brief, BRIEF.brief)
      assert.equal(body.recap.line, BRIEF.recap.line)
    }
  )
})

test('start_interview_session hands back a session to pass on, the brief, and writes nothing', async () => {
  await withClient(
    ({ url, method }) => {
      assert.equal(method, 'GET', 'starting a session commits nothing')
      if (url.pathname === '/api/instance') return { status: 200, body: INSTANCE }
      if (url.pathname === '/api/instance/interview-brief') return { status: 200, body: { ...BRIEF, recap: { ...BRIEF.recap, others: [{ session: 's-other', who: 'b.architect', state: 'in-progress' }] }, heldModules: [{ id: 'risks', stageTitle: 'Shape' }] } }
      return undefined
    },
    async (gantryClient) => {
      const body = payload(await tool('start_interview_session').handler({ slug: 'my-instance', runUntil: 'design', model: 'claude-opus-4-1', who: 'a.architect' }, { gantryClient }))
      assert.match(body.session.id, /^s-[0-9a-f]{6}$/)
      assert.deepEqual({ ...body.session, id: undefined }, { id: undefined, runUntil: 'design', state: 'in-progress', model: 'claude-opus-4-1', who: 'a.architect' })
      assert.equal(body.stageVersion, 'aaaaaaaaaaaaaaaa')
      assert.equal(body.brief, BRIEF.brief)
      assert.equal(body.notes.length, 2)
      assert.match(body.notes[0], /Another session on this stage is not done: s-other \(b\.architect\)/)
      assert.match(body.notes[1], /head start only: risks/)
    }
  )
})

// #338 (docs/adr/0074): as in the browser, starting a session starts gantry serve downloading its copy of each code repository, and waits on none.
test('start_interview_session asks gantry serve to prepare each code repository the brief lists, without waiting for it', async () => {
  const pointer = { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }
  let answerPrepare
  const prepareAnswered = new Promise((resolve) => (answerPrepare = resolve))
  await withClient(
    ({ url, body }) => {
      if (url.pathname === '/api/instance') return { status: 200, body: INSTANCE }
      if (url.pathname === '/api/instance/interview-brief') return { status: 200, body: { ...BRIEF, sources: { mode: 'none', repositories: ['billing-api'] } } }
      if (url.pathname === '/api/instance/sources') return { status: 200, body: { entries: [{ id: 'billing-api', title: 'Billing API', repository: pointer }, { id: 'gone', title: 'Gone', removedAt: 'x', repository: pointer }, { id: 'brief', title: 'Brief', filename: 'b.md' }] } }
      if (url.pathname === '/api/sources/repository') {
        answerPrepare(JSON.parse(body))
        return { status: 200, body: { commit: 'c0ffee', state: 'preparing', receivedBytes: 0 } }
      }
      return undefined
    },
    async (gantryClient, fetch) => {
      const body = payload(await tool('start_interview_session').handler({ slug: 'my-instance' }, { gantryClient }))
      assert.ok(body.session.id)
      assert.deepEqual(await prepareAnswered, { action: 'prepare', repository: pointer })
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(fetch.calls.filter((c) => c.url.pathname === '/api/sources/repository').length, 1, 'only the live repository')
    }
  )
})

test('start_interview_session refuses a run target that is not a stage, or comes before the stage', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance') return { status: 200, body: { ...INSTANCE, stage: { id: 'design' }, currentStageId: 'design' } }
      if (url.pathname === '/api/instance/interview-brief') return { status: 200, body: BRIEF }
      return undefined
    },
    async (gantryClient) => {
      assert.match(payload(await tool('start_interview_session').handler({ slug: 'x', runUntil: 'nope' }, { gantryClient })).error, /must be a stage id of this instance: shape, design/)
      assert.match(payload(await tool('start_interview_session').handler({ slug: 'x', runUntil: 'shape' }, { gantryClient })).error, /comes before the stage being interviewed/)
    }
  )
})

// #332: the Artefacts that can pass each Gate from the briefed stage on, as gantry serve lists them.
const STAGE_ARTEFACTS = [
  { stageId: 'shape', title: 'Shape', gate: 'g1', candidates: [{ id: 'soap', title: 'SOAP' }, { id: 'soap-full', title: 'SOAP (full)' }], lightest: 'soap' },
  { stageId: 'design', title: 'Design', gate: 'g2', candidates: [{ id: 'ssad', title: 'SSAD' }, { id: 'sad', title: 'SAD' }], lightest: 'ssad' },
]
// The brief as gantry serve gives it: aiming for the artefact asked for (none: the candidates are listed and the agent asks). `asked` collects them.
function aimedBrief(url, asked, recap = BRIEF.recap) {
  const artefact = url.searchParams.get('artefact')
  asked.push(artefact)
  return { ...BRIEF, recap, artefact: artefact ? { id: artefact, title: artefact } : null, stageArtefacts: STAGE_ARTEFACTS }
}

test('#332 start_interview_session aims each stage of the run at the artefact chosen for it, and the rest at their lightest', async () => {
  const asked = []
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance') return { status: 200, body: INSTANCE }
      if (url.pathname === '/api/instance/interview-brief') return { status: 200, body: aimedBrief(url, asked) }
      return undefined
    },
    async (gantryClient) => {
      const start = (args) => tool('start_interview_session').handler({ slug: 'my-instance', runUntil: 'design', ...args }, { gantryClient })
      const chosen = payload(await start({ artefacts: { design: 'sad' } }))
      assert.deepEqual(chosen.session.artefacts, { shape: 'soap', design: 'sad' }, 'a stage left out gets its lightest')
      assert.match(chosen.next, /session\.artefacts/)
      assert.equal(asked.at(-1), 'soap', 'the first stage, left out, is briefed aiming for its lightest, as its saves record')
      assert.equal(chosen.artefact.id, 'soap', 'the brief handed back aims for the lightest, not the list of candidates')

      const both = payload(await start({ artefacts: { shape: 'soap-full', design: 'sad' } }))
      assert.deepEqual(both.session.artefacts, { shape: 'soap-full', design: 'sad' })
      assert.equal(asked.at(-1), 'soap-full', 'the first stage is briefed with its chosen artefact')

      const lone = payload(await start({ artefactId: 'soap-full' }))
      assert.deepEqual(lone.session.artefacts, { shape: 'soap-full', design: 'ssad' }, 'a lone artefactId is the first stage\'s choice')
      assert.equal(asked.at(-1), 'soap-full')

      const wrong = await start({ artefacts: { design: 'soap' } })
      assert.equal(wrong.isError, true)
      assert.match(payload(wrong).error, /"soap" can't pass the gate of stage "Design" \(gate: g2\)\. Choose one of: ssad, sad\./)
      const outside = await tool('start_interview_session').handler({ slug: 'my-instance', artefacts: { design: 'sad' } }, { gantryClient })
      assert.match(payload(outside).error, /"design", which is not a stage of this run: shape/)
    }
  )
})

test('#332 a lone artefactId still works against a gantry serve that lists no artefacts per stage; "artefacts" there is refused', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance') return { status: 200, body: INSTANCE }
      if (url.pathname === '/api/instance/interview-brief') return { status: 200, body: BRIEF }
      return undefined
    },
    async (gantryClient) => {
      const lone = payload(await tool('start_interview_session').handler({ slug: 'my-instance', artefactId: 'soap' }, { gantryClient }))
      assert.equal(lone.session.artefacts, undefined)
      const refused = await tool('start_interview_session').handler({ slug: 'my-instance', artefacts: { shape: 'soap' } }, { gantryClient })
      assert.match(payload(refused).error, /does not list the artefacts each stage can aim for/)
    }
  )
})

test('#332 resume_interview_session keeps the artefact the run chose for each stage, briefs the resumed stage at its own, and chooses again only when asked', async () => {
  const asked = []
  const paused = { session: 's-b1', who: 'a.architect', state: 'paused', target: 'design', artefact: 'soap-full', artefacts: { shape: 'soap-full', design: 'sad' } }
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance') return { status: 200, body: INSTANCE }
      if (url.pathname === '/api/instance/interview-brief') return { status: 200, body: aimedBrief(url, asked, { ...BRIEF.recap, resuming: true, sessions: [paused], adoptable: paused }) }
      return undefined
    },
    async (gantryClient) => {
      const resume = (args) => tool('resume_interview_session').handler({ slug: 'my-instance', who: 'a.architect', ...args }, { gantryClient })
      const body = payload(await resume({}))
      assert.equal(body.session.id, 's-b1')
      assert.deepEqual(body.session.artefacts, { shape: 'soap-full', design: 'sad' }, 'the run\'s choices, from the session taken over')
      assert.equal(asked.at(-1), 'soap-full', 'the resumed stage is briefed at the artefact chosen for it')
      assert.equal(body.artefact.id, 'soap-full')
      assert.match(body.next, /session\.artefacts/, 'and the agent is told to brief each later stage with its own')

      const again = payload(await resume({ artefacts: { design: 'ssad' } }))
      assert.deepEqual(again.session.artefacts, { shape: 'soap-full', design: 'ssad' }, 'a stage named again aims for the new choice; the rest keep theirs')
      const lone = payload(await resume({ artefactId: 'soap' }))
      assert.deepEqual(lone.session.artefacts, { shape: 'soap', design: 'sad' })
      assert.equal(asked.at(-1), 'soap')

      const wrong = await resume({ artefacts: { design: 'soap' } })
      assert.equal(wrong.isError, true)
      assert.match(payload(wrong).error, /"soap" can't pass the gate of stage "Design"/)
    }
  )
})

test('#332 resume_interview_session after the earlier stage merged keeps the run\'s choices from the log, with no session on the new stage to take over', async () => {
  const asked = []
  let checked = 0
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance') {
        const moved = checked > 0
        return { status: 200, body: { ...INSTANCE, workspaceBacked: true, pullRequests: { shape: 7 }, stage: { id: moved ? 'design' : 'shape' }, currentStageId: moved ? 'design' : 'shape' } }
      }
      if (url.pathname === '/api/instance/check-status') {
        checked++
        return { status: 200, body: { merged: true, advancedTo: { id: 'design', title: 'Design' } } }
      }
      if (url.pathname === '/api/instance/interview-brief') {
        const body = aimedBrief(url, asked, { ...BRIEF.recap, runArtefacts: { shape: 'soap', design: 'sad' } })
        return { status: 200, body: { ...body, stage: { id: 'design' }, stageArtefacts: STAGE_ARTEFACTS.slice(1) } }
      }
      return undefined
    },
    async (gantryClient) => {
      const body = payload(await tool('resume_interview_session').handler({ slug: 'ado-instance', runUntil: 'design' }, { gantryClient }))
      assert.equal(body.adopted, false)
      assert.deepEqual(body.session.artefacts, { shape: 'soap', design: 'sad' })
      assert.equal(asked.at(-1), 'sad', 'Design is briefed at the artefact the run chose for it, not its lightest')
    },
    { 'ws-1': 'pat' }
  )
})

test('resume_interview_session takes over the paused session, runs Check status once first on a Provider workspace, and follows a merge', async () => {
  let checked = 0
  await withClient(
    ({ url, method }) => {
      if (url.pathname === '/api/instance') {
        // After the merge the instance is on the next stage.
        const moved = checked > 0
        return { status: 200, body: { ...INSTANCE, workspaceBacked: true, pullRequests: { shape: 7 }, stage: { id: moved ? 'design' : 'shape' }, currentStageId: moved ? 'design' : 'shape' } }
      }
      if (url.pathname === '/api/instance/check-status') {
        assert.equal(method, 'POST')
        checked++
        return { status: 200, body: { merged: true, advancedTo: { id: 'design', title: 'Design' }, message: 'Approved.' } }
      }
      if (url.pathname === '/api/instance/interview-brief') {
        assert.equal(url.searchParams.get('stage'), 'design', 'the new current stage after the merge')
        return { status: 200, body: { ...BRIEF, stage: { id: 'design' }, recap: { ...BRIEF.recap, resuming: true, sessions: [{ session: 's-b1', state: 'paused', target: 'design' }], adoptable: { session: 's-b1', who: 'a.architect', state: 'paused', target: 'design' } } } }
      }
      return undefined
    },
    async (gantryClient) => {
      const body = payload(await tool('resume_interview_session').handler({ slug: 'ado-instance', who: 'a.architect', model: 'claude-opus-4-1' }, { gantryClient }))
      assert.equal(checked, 1, 'Check status ran once')
      assert.deepEqual(body.checkStatus, { ran: true, merged: true, message: 'Approved.', advancedTo: { id: 'design', title: 'Design' }, review: null })
      assert.equal(body.adopted, true)
      assert.equal(body.session.id, 's-b1', 'the paused session is carried on')
      assert.equal(body.session.runUntil, 'design')
      assert.match(body.next, /committed log wins/)
    },
    { 'ws-1': 'pat' }
  )
})

test('resume_interview_session on a server workspace runs no Check status and starts a new session when nothing is paused', async () => {
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/check-status') throw new Error('a server workspace has no Pull Request to check')
      if (url.pathname === '/api/instance') return { status: 200, body: INSTANCE }
      if (url.pathname === '/api/instance/interview-brief') return { status: 200, body: BRIEF }
      return undefined
    },
    async (gantryClient) => {
      const body = payload(await tool('resume_interview_session').handler({ slug: 'my-instance' }, { gantryClient }))
      assert.deepEqual(body.checkStatus, { ran: false })
      assert.equal(body.adopted, false)
      assert.match(body.session.id, /^s-[0-9a-f]{6}$/)
    }
  )
})

test('pause_interview_session with no modules saves the log alone, as state paused', async () => {
  await withClient(
    ({ url, method, body }) => {
      if (url.pathname === '/api/instance/decisions') {
        assert.equal(method, 'PUT')
        const sent = JSON.parse(body)
        assert.equal(sent.session.state, 'paused', 'a pause forces the state')
        assert.equal(sent.entries.length, 1)
        return { status: 200, body: { log: {}, session: { id: 's-1', state: 'paused', recordedBy: 'outside agent', entriesRecorded: 1 } } }
      }
      return undefined
    },
    async (gantryClient) => {
      const result = await tool('pause_interview_session').handler({ slug: 'my-instance', session: { id: 's-1', state: 'in-progress' }, entries: [{ kind: 'open-question', question: 'Q?' }] }, { gantryClient })
      assert.equal(result.isError, undefined)
      assert.equal(payload(result).session.recordedBy, 'outside agent')
    }
  )
})

test('pause_interview_session with drafts is a stage save: one PUT with the version, the session and the entries', async () => {
  await withClient(
    ({ url, method, body }) => {
      if (url.pathname === '/api/instance/modules') {
        assert.equal(method, 'PUT')
        const sent = JSON.parse(body)
        assert.equal(sent.baseVersion, 'aaaaaaaaaaaaaaaa')
        assert.equal(sent.session.state, 'paused')
        assert.deepEqual(sent.entries, [{ kind: 'fact', words: 'We launch in March.', fields: ['m.f'] }])
        return { status: 200, body: { saved: ['m'], commit: 'abc123', stageVersion: 'bbbbbbbbbbbbbbbb', session: { id: 's-1', state: 'paused' }, fieldNotes: [] } }
      }
      return undefined
    },
    async (gantryClient) => {
      const result = await tool('pause_interview_session').handler(
        { slug: 'my-instance', session: { id: 's-1' }, stageVersion: 'aaaaaaaaaaaaaaaa', modules: { m: { fields: { f: 'x' } } }, entries: [{ kind: 'fact', words: 'We launch in March.', fields: ['m.f'] }] },
        { gantryClient }
      )
      const body = payload(result)
      assert.equal(body.paused, true)
      assert.equal(body.stageVersion, 'bbbbbbbbbbbbbbbb')
      assert.equal(body.commit, 'abc123')
    }
  )
})

test('update_instance_modules sends the session and entries with the version, and surfaces a refusal for a missing version', async () => {
  await withClient(
    ({ url, body }) => {
      if (url.pathname === '/api/instance/modules') {
        const sent = JSON.parse(body)
        if (!sent.baseVersion) return { status: 400, body: { code: 'stage_version_required', error: 'An outside agent in an interview session must pass the "stageVersion"' } }
        assert.deepEqual(sent.session, { id: 's-1', state: 'saved', model: 'claude-opus-4-1' })
        assert.equal(sent.entries.length, 1)
        return { status: 200, body: { saved: ['m'], stageVersion: 'bbbbbbbbbbbbbbbb', session: { id: 's-1', state: 'saved', recordedBy: 'outside agent', entriesRecorded: 1 } } }
      }
      return undefined
    },
    async (gantryClient) => {
      const args = { slug: 'my-instance', modules: { m: { fields: { f: 'x' } } }, session: { id: 's-1', state: 'saved', model: 'claude-opus-4-1' }, entries: [{ kind: 'answer', question: 'Q', answer: 'A' }] }
      const refused = await instanceTool('update_instance_modules').handler(args, { gantryClient })
      assert.equal(refused.isError, true)
      assert.equal(payload(refused).detail.code, 'stage_version_required')
      const saved = await instanceTool('update_instance_modules').handler({ ...args, stageVersion: 'aaaaaaaaaaaaaaaa' }, { gantryClient })
      assert.equal(payload(saved).session.recordedBy, 'outside agent')
    }
  )
})

test('update_instance_modules outside a session sends neither a session nor entries', async () => {
  await withClient(
    ({ url, body }) => {
      if (url.pathname === '/api/instance/modules') {
        assert.deepEqual(JSON.parse(body), { modules: { m: { fields: { f: 'x' } } } })
        return { status: 200, body: { saved: ['m'] } }
      }
      return undefined
    },
    async (gantryClient) => {
      assert.equal((await instanceTool('update_instance_modules').handler({ slug: 'my-instance', modules: { m: { fields: { f: 'x' } } } }, { gantryClient })).isError, undefined)
    }
  )
})

test('advance_stage and request_approval pass the session id so Gantry can hold the agent to the in-app AI\'s rules', async () => {
  const seen = []
  await withClient(
    ({ url, method }) => {
      if (url.pathname === '/api/instance/advance-stage' || url.pathname === '/api/instance/request-approval') {
        seen.push([url.pathname, method, url.searchParams.get('session')])
        return { status: 400, body: { code: 'session-guard', error: 'An AI in an interview session never passes a Gate' } }
      }
      return undefined
    },
    async (gantryClient) => {
      const advance = await stageTool('advance_stage').handler({ slug: 'my-instance', session: 's-1' }, { gantryClient })
      assert.equal(advance.isError, true)
      assert.equal(payload(advance).detail.code, 'session-guard')
      await stageTool('request_approval').handler({ slug: 'my-instance', session: 's-1' }, { gantryClient })
      await stageTool('advance_stage').handler({ slug: 'my-instance' }, { gantryClient })
    }
  )
  assert.deepEqual(seen, [
    ['/api/instance/advance-stage', 'POST', 's-1'],
    ['/api/instance/request-approval', 'POST', 's-1'],
    ['/api/instance/advance-stage', 'POST', null],
  ])
})

test('get_review_response_list returns the document and counts, or says there is nothing to list', async () => {
  let rows = 2
  await withClient(
    ({ url }) => {
      if (url.pathname === '/api/instance/review-response') {
        return { status: 200, body: rows ? { rows, copies: [{ id: 'r1', name: 'HLD', rows }], filename: 'Plan - Review response list.docx', docxBase64: 'UEs=' } : { rows: 0, note: 'No comment of a Reviewed copy has been answered yet' } }
      }
      return undefined
    },
    async (gantryClient) => {
      const full = payload(await tool('get_review_response_list').handler({ slug: 'my-instance' }, { gantryClient }))
      assert.equal(full.rows, 2)
      assert.equal(full.docxBase64, 'UEs=')
      rows = 0
      assert.match(payload(await tool('get_review_response_list').handler({ slug: 'my-instance' }, { gantryClient })).note, /No comment/)
    }
  )
})

test('record_review_answers raises the answered counts, and needs some', async () => {
  await withClient(
    ({ url, method, body }) => {
      if (url.pathname === '/api/instance/reviews/answered') {
        assert.equal(method, 'PUT')
        assert.deepEqual(JSON.parse(body), { answered: { r1: 3 } })
        return { status: 200, body: { reviews: [{ id: 'r1', comments: 4, commentsAnswered: 3 }] } }
      }
      return undefined
    },
    async (gantryClient) => {
      assert.equal(payload(await tool('record_review_answers').handler({ slug: 'my-instance', answered: { r1: 3 } }, { gantryClient })).reviewedCopies[0].commentsAnswered, 3)
      assert.equal((await tool('record_review_answers').handler({ slug: 'my-instance', answered: {} }, { gantryClient })).isError, true)
    }
  )
})
