import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, symlinkSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseYAML } from 'yaml'

// Catches the class of gap ticket #44 found: a lib/ function existing and
// tested is not the same as its CLI command being wired up.
test('gantry new creates an instance with blank Shape-stage module files', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-cli-'))
  try {
    symlinkSync(resolve('definitions'), join(cwd, 'definitions'))
    const output = execFileSync(
      'node',
      [resolve('bin/gantry.js'), 'new', 'design', 'cli-test', '--owner', 'c.barlow'],
      { cwd, encoding: 'utf8' }
    )
    assert.match(output, /Created instance "cli-test"/)
    assert.match(output, /context, solution-definition, team-and-estimates/)

    const contextPath = join(cwd, 'instances', 'cli-test', 'modules', 'context.md')
    assert.ok(existsSync(contextPath))
    assert.match(readFileSync(contextPath, 'utf8'), /owner: c\.barlow/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

// `--assignee` (#97) sets the instance record's own stored assignee —
// distinct from `--owner` above, which only seeds each first-stage module
// file's own frontmatter `owner`.
test('gantry new --assignee records the instance record\'s own assignee, independently of --owner\'s module-frontmatter seeding', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gantry-cli-'))
  try {
    symlinkSync(resolve('definitions'), join(cwd, 'definitions'))
    execFileSync(
      'node',
      [resolve('bin/gantry.js'), 'new', 'design', 'cli-test', '--owner', 'c.barlow', '--assignee', 'j.smith'],
      { cwd, encoding: 'utf8' }
    )

    const instanceYaml = readFileSync(join(cwd, 'instances', 'cli-test', 'instance.yaml'), 'utf8')
    const instance = parseYAML(instanceYaml)
    assert.equal(instance.assignee, 'j.smith')

    const contextPath = join(cwd, 'instances', 'cli-test', 'modules', 'context.md')
    assert.match(readFileSync(contextPath, 'utf8'), /owner: c\.barlow/)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
