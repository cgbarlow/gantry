import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// design v3 is published (#308), but several suites need a draft of the bundled design Definition to
// change (a logo can only be replaced on a draft). They work on a scratch copy of v3 marked draft, the
// state it was in while the v3 spec (#192) was being built.

/** Marks `<definitionsDir>/design/3` a draft, in place. `definitionsDir` must be a scratch copy. */
export function markDesignV3Draft(definitionsDir) {
  const path = join(definitionsDir, 'design', '3', 'definition.yaml')
  const text = readFileSync(path, 'utf8')
  const draft = text.replace(/^status: published$/m, 'status: draft')
  if (draft === text) throw new Error('design v3 is not published, so there is nothing to mark a draft')
  writeFileSync(path, draft)
}

/** A scratch copy of `definitions/design/3` marked draft, for a suite that copies a version folder somewhere else. Returns its folder. */
export function draftDesignV3Copy() {
  const dir = mkdtempSync(join(tmpdir(), 'gantry-design-v3-draft-'))
  cpSync(join('definitions', 'design', '3'), dir, { recursive: true })
  const path = join(dir, 'definition.yaml')
  writeFileSync(path, readFileSync(path, 'utf8').replace(/^status: published$/m, 'status: draft'))
  return dir
}
