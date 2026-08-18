import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { renderArtefact } from '../lib/render.js'

test('dry-run does not write out/ files', () => {
  execFileSync('rm', ['-rf', 'instances/example-soap/out'])
  const result = renderArtefact('example-soap', 'soap', { dryRun: true })
  assert.equal(existsSync(result.docxPath), false)
  assert.equal(existsSync(result.mdPath), false)
})

test('dry-run compiles the template without writing anything, with no HTML-entity escaping', () => {
  const result = renderArtefact('example-soap', 'soap', { dryRun: true })
  assert.equal(result.dryRun, true)
  assert.match(result.markdown, /# example-soap: Solution on a Page/)
  assert.match(result.markdown, /- Client-facing self-service \(ContosoSelfService\)/)
  assert.doesNotMatch(result.markdown, /&#39;|&quot;|&amp;/)
})

test('renders a real docx styled from the HLD reference doc', () => {
  const result = renderArtefact('example-soap', 'soap')
  assert.equal(existsSync(result.docxPath), true)

  const roundTrip = execFileSync('pandoc', ['-f', 'docx', '-t', 'markdown', result.docxPath], {
    encoding: 'utf8',
  })
  assert.match(roundTrip, /Solution on a Page/)
  assert.match(roundTrip, /Client-facing self-service/)

  const documentXml = execFileSync('unzip', ['-p', result.docxPath, 'word/document.xml'], {
    encoding: 'utf8',
  })
  const headingStyles = [...documentXml.matchAll(/w:pStyle w:val="(Heading\d)"/g)].map((m) => m[1])
  assert.ok(headingStyles.includes('Heading1'))
  assert.ok(headingStyles.includes('Heading2'))
  assert.ok(headingStyles.includes('Heading3'))
  assert.ok((documentXml.match(/<w:numPr>/g) ?? []).length > 0, 'expected real list numbering, not flattened text')

  const referenceStyles = execFileSync(
    'unzip',
    ['-p', 'definitions/design/templates/reference.docx', 'word/styles.xml'],
    { encoding: 'utf8' }
  )
  const outputStyles = execFileSync('unzip', ['-p', result.docxPath, 'word/styles.xml'], {
    encoding: 'utf8',
  })
  const fontsOf = (xml) => new Set([...xml.matchAll(/w:ascii="([^"]+)"/g)].map((m) => m[1]))
  const referenceFonts = fontsOf(referenceStyles)
  const outputFonts = fontsOf(outputStyles)
  for (const font of referenceFonts) {
    assert.ok(outputFonts.has(font), `expected ${font} (from the HLD reference doc) in the rendered docx's fonts`)
  }
})
