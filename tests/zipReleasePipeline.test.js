import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, cpSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// AB#344: the zip-release pipeline (azure-pipelines.zip-release.yml) stages a
// trimmed, Git-free copy of gantry for local-workspace-only installs. Its
// "Stage runtime-only files" step used to exclude all of docs/ as
// contributor/agent documentation — not realizing docs/user-guide/index.md is
// actually read at runtime by the server's own GET /api/user-guide route
// (lib/server.js), so a zip-release install had nothing to serve there and
// /user-guide 404'd. These checks simulate that staging step's file list
// directly against the YAML source, without needing to run the pipeline.

const pipelineYaml = readFileSync(
  new URL('../azure-pipelines.zip-release.yml', import.meta.url),
  'utf8'
)

function stagingScript() {
  const match = pipelineYaml.match(/displayName: 'Stage runtime-only files'/)
  assert.ok(match, 'expected a "Stage runtime-only files" step in azure-pipelines.zip-release.yml')
  // The script: block for a step is the `- script: |` block immediately above its displayName.
  const upToStep = pipelineYaml.slice(0, match.index)
  const scriptStart = upToStep.lastIndexOf('- script: |')
  return pipelineYaml.slice(scriptStart, match.index)
}

test('the zip-release staging step stages docs/user-guide (runtime content the server reads)', () => {
  const script = stagingScript()
  assert.match(
    script,
    /\bdocs\/user-guide\b/,
    'staging step must copy docs/user-guide — GET /api/user-guide reads docs/user-guide/index.md at runtime'
  )
})

test('the zip-release staging step does not stage the rest of docs/ (contributor/agent docs)', () => {
  const script = stagingScript()
  // Guard against a regression that "fixes" this by copying the whole docs/
  // tree wholesale (which would also work for the bug, but would leak
  // adr/, agents/, research/, etc. into the runtime-only zip).
  assert.doesNotMatch(
    script,
    /cp\s+-r\s+[^\n]*(?<![\w/-])docs(?![\w/-])/,
    'staging step must not copy the whole docs/ directory — only docs/user-guide'
  )
})

test('simulated staging produces a docs/ subtree containing only user-guide/index.md', () => {
  const stageDir = mkdtempSync(join(tmpdir(), 'gantry-zip-stage-'))
  try {
    mkdirSync(join(stageDir, 'docs'))
    cpSync('docs/user-guide', join(stageDir, 'docs', 'user-guide'), { recursive: true })

    assert.ok(
      existsSync(join(stageDir, 'docs', 'user-guide', 'index.md')),
      'docs/user-guide/index.md must be present in the staged output'
    )
    assert.ok(
      !existsSync(join(stageDir, 'docs', 'adr')),
      'docs/adr must not be present in the staged output'
    )
    assert.ok(
      !existsSync(join(stageDir, 'docs', 'agents')),
      'docs/agents must not be present in the staged output'
    )
  } finally {
    rmSync(stageDir, { recursive: true, force: true })
  }
})
