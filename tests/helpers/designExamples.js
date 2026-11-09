import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// #359: design v4 drops `team-and-estimates.references`, and the two bundled design examples moved
// onto v4 without their References sections. The suites that pin design v3's behaviour still need the
// examples as they were on v3, References and all: on v3 the Full SOAP's Gate asks for References, and
// the SOAP, SAD and SSAD print it. These are the sections #359 took out of each example's
// `team-and-estimates.md`, word for word, so a v3 copy built here is the 0.16.3 example exactly.
export const V3_REFERENCES = {
  'kiwi-cover-mutual': `## References

- Claims Service Review 2025, KCM Claims Operations
- BIBIT gateway contract and integration guide v4.2
- ArchiMate 3.2 Specification, The Open Group
- KCM Delivery Office T-shirt sizing guide v3
`,
  gantry: `## References

- README.md, "Deploying to a server (UAT / production)"
- \`azure-pipelines.release.yml\`, \`azure-pipelines.yml\` and \`ContainerFile\`: how the image is built, tested and published
- docs/adr/0005, docs/adr/0010 and docs/adr/0029: why instance data lives in Azure DevOps workspace repositories
- Azure Container Apps documentation: ingress, storage mounts, scaling, revisions, health probes and monitoring
- Azure DevOps work items #354 (this initiative) and #353 (Mermaid rendering)
`,
}

const EXAMPLES_DIR = join('workspaces', 'examples')

/** A `team-and-estimates.md` text with the example's v3 References section put back at its end, where it was. */
export function withV3References(slug, text) {
  const section = V3_REFERENCES[slug]
  if (!section || text.includes(section.split('\n')[0])) return text
  return `${text.trimEnd()}\n\n${section}`
}

/** Puts back one example's v3 References section and pins it to design v3, in a copy of it under `dir`. */
export function moveExampleBackToV3(dir, slug) {
  const modulePath = join(dir, slug, 'modules', 'team-and-estimates.md')
  writeFileSync(modulePath, withV3References(slug, readFileSync(modulePath, 'utf8')))
  const instancePath = join(dir, slug, 'instance.yaml')
  writeFileSync(instancePath, readFileSync(instancePath, 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3'))
}

let v3ExamplesDir = null

/**
 * A scratch copy of the whole Examples workspace with both design examples as they were on design v3:
 * pinned to v3, each with its References section back. Made once per test process and removed when it
 * exits; a suite that writes to an example copies it again from here first, as it would from
 * workspaces/examples.
 */
export function designV3Examples() {
  if (v3ExamplesDir) return v3ExamplesDir
  const root = mkdtempSync(join(tmpdir(), 'gantry-design-v3-examples-'))
  process.on('exit', () => rmSync(root, { recursive: true, force: true }))
  cpSync(EXAMPLES_DIR, root, { recursive: true })
  for (const slug of Object.keys(V3_REFERENCES)) moveExampleBackToV3(root, slug)
  v3ExamplesDir = root
  return root
}
