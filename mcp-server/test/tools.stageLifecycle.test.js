import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGantryClient } from '../src/gantryClient.js'
import { tools } from '../src/tools/stageLifecycle.tools.js'
import { stubFetch } from './helpers/fakeFetch.js'

const BASE_URL = 'https://gantry.example.test'

const checkGateTool = tools.find((t) => t.name === 'check_gate')
const advanceStageTool = tools.find((t) => t.name === 'advance_stage')
const requestApprovalTool = tools.find((t) => t.name === 'request_approval')
const checkStatusTool = tools.find((t) => t.name === 'check_status')
const requestReviewTool = tools.find((t) => t.name === 'request_review')
const checkReviewStatusTool = tools.find((t) => t.name === 'check_review_status')
const reopenStageTool = tools.find((t) => t.name === 'reopen_stage')
const syncStageBranchTool = tools.find((t) => t.name === 'sync_stage_branch')

function localWorkspaceStub(extra) {
  return ({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId: 'srv-1', scope: 'srv-1' } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [{ id: 'srv-1', name: 'Local' }] }
    return extra({ url, method, body })
  }
}

function providerWorkspaceStub(workspaceId, extra) {
  return ({ url, method, body }) => {
    if (url.pathname === '/api/instance/workspace') return { status: 200, body: { workspaceId, scope: workspaceId } }
    if (url.pathname === '/api/workspaces') return { status: 200, body: [{ id: workspaceId, provider: 'azure-devops' }] }
    if (url.pathname === '/api/server-workspaces') return { status: 200, body: [] }
    return extra({ url, method, body })
  }
}

// ---------------------------------------------------------------------------
// check_gate
// ---------------------------------------------------------------------------

test('check_gate rejects a call with neither slug nor ref, without touching the network', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await checkGateTool.handler({}, { gantryClient })
    assert.equal(result.isError, true)
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('check_gate reads a local instance\'s gate status with no credential', async () => {
  const fetch = stubFetch(
    localWorkspaceStub(({ url }) => {
      if (url.pathname === '/api/instance/check') {
        assert.equal(url.searchParams.get('slug'), 'my-instance')
        return { status: 200, body: { complete: true, modules: [], artefacts: [] } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await checkGateTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.complete, true)

    const actionCall = fetch.calls.find((c) => c.url.pathname === '/api/instance/check')
    assert.equal(actionCall.headers.authorization, undefined)
  } finally {
    fetch.restore()
  }
})

test('check_gate reports missing_workspace_pat for a Provider-backed instance and never calls the check route', async () => {
  const fetch = stubFetch(providerWorkspaceStub('ws-2', () => undefined))
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await checkGateTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/check'), false)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// advance_stage — local instance advances end-to-end once its gate has passed, blocked while it hasn't
// ---------------------------------------------------------------------------

test('advance_stage advances a local instance whose gate has passed', async () => {
  const fetch = stubFetch(
    localWorkspaceStub(({ url, method }) => {
      if (url.pathname === '/api/instance/advance-stage' && method === 'POST') {
        return { status: 200, body: { stage: 'design' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await advanceStageTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.stage, 'design')
  } finally {
    fetch.restore()
  }
})

test('advance_stage is blocked (400) while the gate has not passed', async () => {
  const fetch = stubFetch(
    localWorkspaceStub(({ url, method }) => {
      if (url.pathname === '/api/instance/advance-stage' && method === 'POST') {
        return { status: 400, body: { error: 'Stage "discovery" has not passed its gate' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await advanceStageTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /400/)
    assert.match(payload.detail.error, /gate/)
  } finally {
    fetch.restore()
  }
})

test('advance_stage is rejected for a Workspace-backed instance', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method }) => {
      if (url.pathname === '/api/instance/advance-stage' && method === 'POST') {
        return { status: 400, body: { error: 'Instance "ado-instance" is Workspace-backed — it advances via its own Pull Request flow.' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await advanceStageTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.detail.error, /Workspace-backed/)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// request_approval -> check_status end-to-end (merges and advances on approval)
// ---------------------------------------------------------------------------

test('request_approval opens a stage Pull Request for a Workspace-backed instance', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method, body }) => {
      if (url.pathname === '/api/instance/request-approval' && method === 'POST') {
        assert.deepEqual(JSON.parse(body), {})
        return { status: 200, body: { pullRequestId: 42, pullRequestUrl: 'https://ado.example/pr/42' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await requestApprovalTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.pullRequestId, 42)
  } finally {
    fetch.restore()
  }
})

test('request_approval is rejected for a local instance', async () => {
  const fetch = stubFetch(
    localWorkspaceStub(({ url, method }) => {
      if (url.pathname === '/api/instance/request-approval' && method === 'POST') {
        return { status: 400, body: { error: 'Instance "my-instance" is not Workspace-backed — there is no stage branch or Pull Request to open for it.' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await requestApprovalTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.detail.error, /not Workspace-backed/)
  } finally {
    fetch.restore()
  }
})

test('check_status merges the Pull Request and advances the stage once approved', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method }) => {
      if (url.pathname === '/api/instance/check-status' && method === 'POST') {
        return { status: 200, body: { approved: true, merged: true, stage: 'design' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await checkStatusTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.merged, true)
    assert.equal(payload.stage, 'design')
  } finally {
    fetch.restore()
  }
})

test('check_status reports a still-pending review without merging', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method }) => {
      if (url.pathname === '/api/instance/check-status' && method === 'POST') {
        return { status: 200, body: { approved: false, merged: false, pending: true } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await checkStatusTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.merged, false)
    assert.equal(payload.pending, true)
  } finally {
    fetch.restore()
  }
})

test('check_status reports missing_workspace_pat and never calls check-status', async () => {
  const fetch = stubFetch(providerWorkspaceStub('ws-2', () => undefined))
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await checkStatusTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.error, 'missing_workspace_pat')
    assert.equal(fetch.calls.some((c) => c.url.pathname === '/api/instance/check-status'), false)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// request_review / check_review_status — round-trip independently of the approval pair
// ---------------------------------------------------------------------------

test('request_review creates a tracked review request for a Workspace-backed instance', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method, body }) => {
      if (url.pathname === '/api/instance/request-review' && method === 'POST') {
        assert.deepEqual(JSON.parse(body), { stage: 'discovery', reviewer: 'alex' })
        return { status: 200, body: { reviewId: 'task-7', status: 'requested' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await requestReviewTool.handler({ slug: 'ado-instance', stage: 'discovery', reviewer: 'alex' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.reviewId, 'task-7')
  } finally {
    fetch.restore()
  }
})

test('request_review is rejected for a local instance', async () => {
  const fetch = stubFetch(
    localWorkspaceStub(({ url, method }) => {
      if (url.pathname === '/api/instance/request-review' && method === 'POST') {
        return { status: 400, body: { error: 'Instance "my-instance" is not Workspace-backed — review requests are only supported for Workspace-backed instances.' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await requestReviewTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, true)
  } finally {
    fetch.restore()
  }
})

test('check_review_status reads back the tracked review\'s state independently of request_approval/check_status', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method, body }) => {
      if (url.pathname === '/api/instance/review-status' && method === 'POST') {
        assert.deepEqual(JSON.parse(body), { stage: 'discovery', reviewId: 'task-7' })
        return { status: 200, body: { reviewId: 'task-7', status: 'completed' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await checkReviewStatusTool.handler({ slug: 'ado-instance', stage: 'discovery', reviewId: 'task-7' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.status, 'completed')
  } finally {
    fetch.restore()
  }
})

test('check_review_status surfaces gantry serve\'s authentication_required 401', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-3', ({ url, method }) => {
      if (url.pathname === '/api/instance/review-status' && method === 'POST') {
        return { status: 401, body: { error: 'authentication_required', message: 'rejected' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-3': 'stale-pat' } })
    const result = await checkReviewStatusTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.detail.error, 'authentication_required')
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// reopen_stage
// ---------------------------------------------------------------------------

test('reopen_stage rejects a call with no stage without touching the network', async () => {
  const fetch = stubFetch(() => {
    throw new Error('should not be called')
  })
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await reopenStageTool.handler({ slug: 'ado-instance' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /stage/)
    assert.equal(fetch.calls.length, 0)
  } finally {
    fetch.restore()
  }
})

test('reopen_stage succeeds against a mocked Workspace-backed instance', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method, body }) => {
      if (url.pathname === '/api/instance/stage/reopen' && method === 'POST') {
        assert.deepEqual(JSON.parse(body), { stage: 'discovery' })
        return { status: 200, body: { stage: 'discovery', reopened: true } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await reopenStageTool.handler({ slug: 'ado-instance', stage: 'discovery' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.reopened, true)
  } finally {
    fetch.restore()
  }
})

test('reopen_stage surfaces a 409 when the stage cannot be re-opened right now', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method }) => {
      if (url.pathname === '/api/instance/stage/reopen' && method === 'POST') {
        return { status: 409, body: { error: 'Stage "discovery" cannot be re-opened while its Pull Request is still open' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await reopenStageTool.handler({ slug: 'ado-instance', stage: 'discovery' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /409/)
  } finally {
    fetch.restore()
  }
})

// ---------------------------------------------------------------------------
// sync_stage_branch
// ---------------------------------------------------------------------------

test('sync_stage_branch merges main into the stage branch on a mocked success', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method }) => {
      if (url.pathname === '/api/instance/stage-branch/sync' && method === 'POST') {
        assert.equal(url.searchParams.get('stage'), 'discovery')
        return { status: 200, body: { branch: 'stage/discovery', objectId: 'abc123', fastForward: true } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await syncStageBranchTool.handler({ slug: 'ado-instance', stage: 'discovery' }, { gantryClient })
    assert.equal(result.isError, undefined)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.fastForward, true)
  } finally {
    fetch.restore()
  }
})

test('sync_stage_branch surfaces a 409 merge conflict with the opened Pull Request to resolve it in', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method }) => {
      if (url.pathname === '/api/instance/stage-branch/sync' && method === 'POST') {
        return { status: 409, body: { error: 'Merge conflict — resolve in the opened pull request', pullRequestUrl: 'https://ado.example/pr/9', pullRequestId: 9 } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await syncStageBranchTool.handler({ slug: 'ado-instance', stage: 'discovery' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /409/)
    assert.equal(payload.detail.pullRequestId, 9)
  } finally {
    fetch.restore()
  }
})

test('sync_stage_branch surfaces a 404 when the stage has no branch yet', async () => {
  const fetch = stubFetch(
    providerWorkspaceStub('ws-1', ({ url, method }) => {
      if (url.pathname === '/api/instance/stage-branch/sync' && method === 'POST') {
        return { status: 404, body: { error: 'No stage branch for "ado-instance" stage "discovery" — nothing to sync' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: { 'ws-1': 'secret-pat' } })
    const result = await syncStageBranchTool.handler({ slug: 'ado-instance', stage: 'discovery' }, { gantryClient })
    assert.equal(result.isError, true)
    const payload = JSON.parse(result.content[0].text)
    assert.match(payload.error, /404/)
  } finally {
    fetch.restore()
  }
})

test('sync_stage_branch is rejected for a local instance', async () => {
  const fetch = stubFetch(
    localWorkspaceStub(({ url, method }) => {
      if (url.pathname === '/api/instance/stage-branch/sync' && method === 'POST') {
        return { status: 400, body: { error: 'Instance "my-instance" is not Workspace-backed — stage-branch sync is only for Workspace-backed instances' } }
      }
      return undefined
    })
  )
  try {
    const gantryClient = createGantryClient({ baseUrl: BASE_URL, workspacePats: {} })
    const result = await syncStageBranchTool.handler({ slug: 'my-instance' }, { gantryClient })
    assert.equal(result.isError, true)
  } finally {
    fetch.restore()
  }
})
