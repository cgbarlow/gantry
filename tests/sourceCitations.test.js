import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stringify as stringifyYAML } from 'yaml'
import {
  buildSourceAppendix,
  citedSourceIds,
  findSourceCitations,
  numberCitationCrossReferences,
  sourceAppendixProblem,
  sourceCitationFor,
  sourceCitationsForWord,
  sourceEntriesForRender,
} from '../web/lib/sourceCitations.js'
import { ASSET_IMAGE_EXTENSIONS, assetFilenameForSource, canUseSourceAsImage } from '../web/lib/sourceDocuments.js'
import { renderArtefact } from '../lib/render.js'
import { runLocalWorkspaceCompute, LocalWorkspaceRequestError } from '../lib/localWorkspace.js'
import { createAsset, listAssets } from '../lib/assets.js'
import { findDefinitionProblemsInStructure, loadDefinition, buildDefinitionYamlObject } from '../lib/definition.js'
import { findLocalDefinitionProblems } from '../web/lib/localStatus.js'
import { removeCitations } from './helpers/uncite.js'
import { docxPart, footnoteMarks, footnotes } from './helpers/wordDocx.js'

// #281 (map #238, decided in #245): Source documents cited from module content as `[text](source:<id>)`, printed in Word as a real footnote (#351), and an optional Sources appendix an Artefact's Definition opts into with `source-appendix: true`.

describe('the citation syntax', () => {
  test('a citation is a link to source:<id>, whatever its text', () => {
    assert.deepEqual(findSourceCitations('See [Client brief, p. 4](source:client-brief) and [Notes](source:notes-2).'), [
      { id: 'client-brief', text: 'Client brief, p. 4' },
      { id: 'notes-2', text: 'Notes' },
    ])
  })

  test('an image, an ordinary link, a code span and a fenced block are not citations', () => {
    const markdown = [
      '![a picture](source:client-brief)',
      '[the web](https://example.com/source:x)',
      'Type `[Brief](source:in-code)` to cite.',
      '```',
      '[Brief](source:in-fence)',
      '```',
      '~~~markdown',
      '[Brief](source:in-tildes)',
      '~~~',
      'After: [Real](source:real)',
    ].join('\n')
    assert.deepEqual(citedSourceIds(markdown), ['real'])
  })

  test('link text may hold escaped brackets, and a citation cannot span lines', () => {
    assert.deepEqual(findSourceCitations('[Plan \\[v2\\], p. 3](source:plan)'), [{ id: 'plan', text: 'Plan [v2], p. 3' }])
    assert.deepEqual(findSourceCitations('[broken\ntext](source:plan)'), [])
  })

  test('link text may hold closed brackets, and a bracket of the writer\'s before a citation is not part of it (#351)', () => {
    assert.deepEqual(findSourceCitations('[see [x], p. 3](source:plan)'), [{ id: 'plan', text: 'see [x], p. 3' }])
    assert.deepEqual(findSourceCitations('[[a](source:a); [b](source:b)]'), [
      { id: 'a', text: 'a' },
      { id: 'b', text: 'b' },
    ])
  })

  test('the ids cited are listed once each, in the order they are first cited', () => {
    assert.deepEqual(citedSourceIds('[b](source:b) [a](source:a) [b again](source:b)'), ['b', 'a'])
  })

  test('the citation to paste for a document uses its title and id', () => {
    assert.equal(sourceCitationFor({ id: 'client-brief', title: 'Client brief' }), '[Client brief](source:client-brief)')
    assert.equal(sourceCitationFor({ id: 'plan', title: 'Plan [v2]' }), '[Plan \\[v2\\]](source:plan)')
  })
})

describe('what Word prints', () => {
  // #351: a citation in running text is a real Word footnote. The compile step writes it as a Pandoc inline note, `^[words]`, which
  // Pandoc turns into a native footnote; the brackets around it go, and the mark sits against the word before it.
  test('a citation in running text is an inline note holding its words, against the word before it', () => {
    assert.equal(sourceCitationsForWord('Median time is 12.4 days [Client brief, p. 4](source:client-brief).'), 'Median time is 12.4 days^[Client brief, p. 4].')
    assert.equal(sourceCitationsForWord('see [Client brief, p. 4](source:client-brief) for the figures'), 'see^[Client brief, p. 4] for the figures')
  })

  test('brackets that hold nothing but citations go, so no empty "()" is left', () => {
    assert.equal(sourceCitationsForWord('…built from it ([operating model](source:operating-model)).'), '…built from it^[operating model].')
    // Two notes side by side keep a space between them: Pandoc would read `^[a]^[b]` as a superscript "[a]".
    assert.equal(sourceCitationsForWord('x ([a](source:a); [b](source:b)) y'), 'x^[a] ^[b] y')
    assert.equal(sourceCitationsForWord('x [[a](source:a), [b](source:b)] y'), 'x^[a] ^[b] y')
    assert.equal(sourceCitationsForWord('x ( [a](source:a) ) y'), 'x^[a] y')
  })

  test('brackets that hold anything else stay, and two citations side by side are two notes', () => {
    assert.equal(sourceCitationsForWord('x (see [a](source:a)) y'), 'x (see^[a]) y')
    assert.equal(sourceCitationsForWord('x ([a](source:a) and more) y'), 'x (^[a] and more) y')
    assert.equal(sourceCitationsForWord('x [a](source:a) [b](source:b) y'), 'x^[a] ^[b] y')
    assert.equal(sourceCitationsForWord('x [a](source:a)[b](source:b) y'), 'x^[a] ^[b] y')
    assert.equal(sourceCitationsForWord('E = mc[a](source:a)^2^'), 'E = mc^[a] ^2^', "and so does a note before the writer's own superscript")
    assert.equal(sourceCitationsForWord('x \\([a](source:a)) y'), 'x \\(^[a]) y', 'an escaped bracket is the text\'s own')
  })

  test('an empty text falls back on the document title, then the id', () => {
    assert.equal(sourceCitationsForWord('x [](source:a) y [](source:b)', (id) => (id === 'a' ? 'Client brief' : undefined)), 'x^[Client brief] y^[b]')
  })

  test('nothing in the words can break the note, and the author\'s own Markdown in them is kept', () => {
    // The link text was already Markdown, and stays so, as it does where a citation labels a list item: only a `^`, which
    // Pandoc could read as the end of a superscript begun by the note's own, is escaped. Its brackets are closed or escaped.
    assert.equal(sourceCitationsForWord('x [Plan \\[v2\\]^2 *draft*](source:plan) y'), 'x^[Plan \\[v2\\]\\^2 *draft*] y')
    assert.equal(sourceCitationsForWord('x [*Client brief*, p. 4](source:a) y'), 'x^[*Client brief*, p. 4] y')
    // A document's title, a repository's file and its commit are not Markdown, so they are taken literally.
    assert.equal(sourceCitationsForWord('x [](source:plan) y', () => 'A_b <c> @d $e'), 'x^[A\\_b \\<c\\> \\@d \\$e] y')
    assert.equal(sourceCitationsForWord('x [*a*](source:r?path=src/my_file.ts) y'), 'x^[*a*, src/my\\_file.ts] y')
  })

  test("a repository citation's note names the file and the short commit it was read at", () => {
    const HEAD = 'de62a9e1234567890abcdef1234567890abcdef1'
    assert.equal(sourceCitationsForWord(`as the [gantry](source:gantry?path=README.md&commit=${HEAD}) says`), 'as the^[gantry, README.md, at commit de62a9e] says')
    // The words Copy citation writes already name the file, so it isn't said twice.
    assert.equal(sourceCitationsForWord(`x [Gantry, README.md](source:gantry?path=README.md&commit=${HEAD}) y`), 'x^[Gantry, README.md, at commit de62a9e] y')
    assert.equal(sourceCitationsForWord('x [Gantry](source:gantry) y'), 'x^[Gantry] y', 'a citation of the repository as a whole is its words')
  })

  test('a citation that labels a list item or a table cell prints its words, with no brackets and no note', () => {
    assert.equal(sourceCitationsForWord('- [Gantry_Two_pager](source:gantry-two-pager): scope, costing'), '- Gantry_Two_pager: scope, costing')
    assert.equal(sourceCitationsForWord('1. [](source:a) and more [b](source:b)', () => 'Client brief'), '1. Client brief and more^[b]')
    assert.equal(sourceCitationsForWord('> * **[Brief](source:a)**: x'), '> * **Brief**: x')
    const table = '| Document | Note |\n| --- | --- |\n| [Brief](source:a) | as said [Notes](source:b) |'
    assert.equal(sourceCitationsForWord(table), '| Document | Note |\n| --- | --- |\n| Brief | as said^[Notes] |')
    const bare = 'Document | Note\n--- | ---\n[Brief](source:a) | x'
    assert.equal(sourceCitationsForWord(bare), 'Document | Note\n--- | ---\nBrief | x', 'a table without the outer pipes too')
    // An item that opens with bracketed citations is not labelled by them; the list marker stays where it was.
    assert.equal(sourceCitationsForWord('- ([a](source:a)) x'), '- ^[a] x')
    // A Word Field tag (#301) in front of the citation is not something in the item.
    const tagged = '- `<w:bookmarkStart w:id="2000000" w:name="gf_m_f"/>`{=openxml}[Brief](source:a): x'
    assert.equal(sourceCitationsForWord(tagged), '- `<w:bookmarkStart w:id="2000000" w:name="gf_m_f"/>`{=openxml}Brief: x')
  })

  test('a paragraph that is not a list or a table, and a heading, are not mistaken for one', () => {
    assert.equal(sourceCitationsForWord('[Brief](source:a) says so.'), '^[Brief] says so.')
    assert.equal(sourceCitationsForWord('a | b [Brief](source:a)'), 'a | b^[Brief]')
    assert.equal(sourceCitationsForWord('## Background ([Brief](source:a))'), '## Background (Brief)', 'a heading prints the words as before, since a note there would also land in the table of contents')
  })

  test('a Field tag Span (#301) around a citation is not taken for square brackets', () => {
    // Pandoc 2 reads `[^` as the start of a footnote reference, so a note straight after a `[` has a space before it; a Span
    // drops it, so Word prints nothing extra.
    assert.equal(sourceCitationsForWord('x [[a](source:a)]{#gf_m_f} y'), 'x [ ^[a]]{#gf_m_f} y')
    assert.equal(sourceCitationsForWord('Owner: [[Brief](source:a) says so.]{#gf_m_f}'), 'Owner: [ ^[Brief] says so.]{#gf_m_f}')
  })

  test('two marks with only punctuation between them, and a mark beside the writer\'s own ^, are never read as a superscript', () => {
    // Pandoc 2 reads `^[a],^[b]` as a superscript "[a]," followed by "[b]", so whatever sits between a note and the next `^`
    // keeps a space in it.
    assert.equal(sourceCitationsForWord('two places [Client brief, p. 4](source:a), [Notes](source:b).'), 'two places^[Client brief, p. 4], ^[Notes].')
    assert.equal(sourceCitationsForWord('(see [Brief](source:a); [Notes](source:b))'), '(see^[Brief]; ^[Notes])')
    assert.equal(sourceCitationsForWord('x [a](source:a),[b](source:b) y'), 'x^[a], ^[b] y')
    assert.equal(sourceCitationsForWord('x [a](source:a)x^2^ y'), 'x^[a]x ^2^ y')
    // A word before the mark that holds a `^` of the writer's keeps its space, or `^2)^[a]` would be a superscript "2)".
    assert.equal(sourceCitationsForWord('it is O(n^2) [a](source:a).'), 'it is O(n^2) ^[a].')
    assert.equal(sourceCitationsForWord('it is O(n\\^2) [a](source:a).'), 'it is O(n\\^2)^[a].', 'an escaped ^ is plain text')
  })

  test('a definition list keeps the space after its marker', () => {
    assert.equal(sourceCitationsForWord('Term\n: [a](source:a) definition'), 'Term\n: ^[a] definition')
    assert.equal(sourceCitationsForWord('Term\n\n:   [a](source:a) definition'), 'Term\n\n:   ^[a] definition')
    assert.equal(sourceCitationsForWord('Term\n~ [a](source:a) definition'), 'Term\n~ ^[a] definition')
    assert.equal(sourceCitationsForWord('Owner: [a](source:a) x'), 'Owner:^[a] x', 'a colon after a word is not a marker')
  })

  test('the Pandoc this server converts with reads every one of them as notes, with nothing left as a superscript or literal', async () => {
    const { execFileSync } = await import('node:child_process')
    const cases = [
      ['two places [Client brief, p. 4](source:a), [Notes](source:b).', 2],
      ['(see [Brief](source:a); [Notes](source:b))', 2],
      ['x [a](source:a),[b](source:b) y', 2],
      ['x ([a](source:a); [b](source:b)) y', 2],
      ['E = mc[a](source:a)^2^', 1],
      ['it is O(n^2) [a](source:a).', 1],
      ['x [[a](source:a)]{#gf_m_f} y', 1],
      ['Owner: [[Brief](source:a) says so.]{#gf_m_f}', 1],
      ['x [Plan \\[v2\\]^2 *draft*](source:plan) y', 1],
      ['Term\n: [a](source:a) definition', 1],
    ]
    for (const [markdown, notes] of cases) {
      const ast = JSON.stringify(JSON.parse(execFileSync('pandoc', ['-f', 'markdown', '-t', 'json'], { input: sourceCitationsForWord(markdown), encoding: 'utf8' })).blocks)
      assert.equal(ast.match(/"t":"Note"/g)?.length ?? 0, notes, `${markdown} → ${sourceCitationsForWord(markdown)}`)
      assert.doesNotMatch(ast, /"t":"Superscript","c":\[\{"t":"Str","c":"\[/, markdown)
      assert.doesNotMatch(ast, /"\^\[|"\[\^/, `${markdown}: no note left as literal text`)
      if (markdown.includes('{#gf_m_f}')) assert.match(ast, /"t":"Span","c":\[\["gf_m_f"/, `${markdown}: the Field's bookmark is still there`)
      if (markdown.startsWith('Term')) assert.match(ast, /"t":"DefinitionList"/, markdown)
      if (markdown.includes('*draft*')) assert.match(ast, /"t":"Emph"/, markdown)
    }
  })

  test('code, fenced blocks, images and other links are left exactly as they were', () => {
    const markdown = 'Use `[T](source:a)`.\n\n```\n[T](source:a)\n```\n\n![T](source:a) [T](https://example.com)'
    assert.equal(sourceCitationsForWord(markdown), markdown)
  })

  test('text with no citation comes back unchanged', () => {
    const markdown = '# Title\n\nSome *words* and a [link](https://example.com).\n'
    assert.equal(sourceCitationsForWord(markdown), markdown)
  })
})

describe('a reference cited again (#353)', () => {
  // The first citation of a reference is its footnote, with a bookmark around the mark; every later one with the same words is a
  // NOTEREF cross-reference to that bookmark, showing the footnote's number. Read back here as `⟦1⟧^[words]⟦/1⟧` (a footnote in
  // bookmark 1) and `⟨1:3⟩` (a cross-reference to bookmark 1 showing "3"), so the tests say what Word gets.
  const readable = (text) =>
    text
      .replace(/``<w:bookmarkStart w:id="(\d+)" w:name="_RefCitation(\d+)"\/>``\{=openxml\}/g, (_, id, n) => {
        assert.equal(Number(id), 3000000 + Number(n), 'bookmark ids clear of Pandoc\'s, the table of contents\' and the Field tags\'')
        return `⟦${n}⟧`
      })
      .replace(/``<w:bookmarkEnd w:id="(\d+)"\/>``\{=openxml\}/g, (_, id) => `⟦/${Number(id) - 3000000}⟧`)
      .replace(/``<w:r>[^`]*? NOTEREF _RefCitation(\d+) \\f \\h [^`]*?<w:t>(\d*)<\/w:t>[^`]*``\{=openxml\}/g, '⟨$1:$2⟩')
  const word = (markdown, titleFor) => readable(sourceCitationsForWord(markdown, titleFor))

  test('a citing A, B, then A again makes two footnotes, and the third shows the first one\'s number', () => {
    assert.equal(word('x [A](source:a) y [B](source:b) z [A](source:a).'), 'x⟦1⟧^[A]⟦/1⟧ y^[B] z⟨1:1⟩.')
    assert.equal(word('x [A](source:a) y [A](source:a) z [A](source:a).'), 'x⟦1⟧^[A]⟦/1⟧ y⟨1:1⟩ z⟨1:1⟩.')
  })

  test('the same reference means the same printed words: a section, a file or a commit makes another one', () => {
    assert.equal(
      word('a [Gantry hosting](source:h) b [Gantry hosting, Constraints](source:h) c [Gantry hosting, Constraints](source:h) d [Gantry hosting](source:h) e [Gantry hosting, Out of scope](source:h)'),
      'a⟦1⟧^[Gantry hosting]⟦/1⟧ b⟦2⟧^[Gantry hosting, Constraints]⟦/2⟧ c⟨2:2⟩ d⟨1:1⟩ e^[Gantry hosting, Out of scope]'
    )
    const A = 'de62a9e1234567890abcdef1234567890abcdef1'
    const B = '0123456789abcdef0123456789abcdef01234567'
    assert.equal(
      word(`a [gantry](source:g?path=README.md&commit=${A}) b [gantry](source:g?path=README.md&commit=${B}) c [gantry](source:g?path=README.md&commit=${A})`),
      'a⟦1⟧^[gantry, README.md, at commit de62a9e]⟦/1⟧ b^[gantry, README.md, at commit 0123456] c⟨1:1⟩'
    )
    // Compared as the footnote prints them: after the fallback on the document's title, with the spaces around trimmed.
    assert.equal(word('a [](source:a) b [ Client brief ](source:b) c [Client brief](source:a)', () => 'Client brief'), 'a⟦1⟧^[Client brief]⟦/1⟧ b⟨1:1⟩ c⟨1:1⟩')
  })

  test('the numbers count the author\'s own footnotes, inline or by label, and nothing that only looks like one', () => {
    const markdown = 'x [A](source:a) y^[mine] z [B](source:b) w[^n] v [B](source:b) u [A](source:a).\n\n[^n]: Defined.'
    assert.equal(word(markdown), 'x⟦1⟧^[A]⟦/1⟧ y^[mine] z⟦2⟧^[B]⟦/2⟧ w[^n] v⟨2:3⟩ u⟨1:1⟩.\n\n[^n]: Defined.')
    // Before the first citation: a label used twice is two footnotes. Not footnotes: an undefined label, a definition, code,
    // an escaped `^`, an HTML comment and a fenced block.
    const before = 'One[^n] two[^n] `^[code]` \\^[escaped] [^undefined] <!-- ^[comment] -->\n\n```\n^[fenced]\n```\n\n[^n]: Defined.\n\nSee [A](source:a) and [A](source:a).'
    assert.match(word(before), /See⟦1⟧\^\[A\]⟦\/1⟧ and⟨1:3⟩\.$/)
  })

  test('a citation printed as plain words starts no footnote, and a reference cited once is the note it was', () => {
    assert.equal(
      word('## Intro ([A](source:a))\n\n- [A](source:a): the brief\n\n| Doc |\n| --- |\n| [A](source:a) |\n\nText [A](source:a) and [A](source:a).'),
      '## Intro (A)\n\n- A: the brief\n\n| Doc |\n| --- |\n| A |\n\nText⟦1⟧^[A]⟦/1⟧ and⟨1:1⟩.'
    )
    assert.equal(sourceCitationsForWord('- [A](source:a): x\n\nSee [A](source:a).'), '- A: x\n\nSee^[A].')
  })

  test('the whole text is one document: a reference cited on both sides of a fenced block, or in a table cell, is footnoted once', () => {
    assert.equal(word('x [a](source:a)\n\n```\ncode\n```\n\ny [a](source:a)'), 'x⟦1⟧^[a]⟦/1⟧\n\n```\ncode\n```\n\ny⟨1:1⟩')
    assert.equal(word('See [a](source:a).\n\n| Doc | Note |\n| --- | --- |\n| x | as said [a](source:a) |'), 'See⟦1⟧^[a]⟦/1⟧.\n\n| Doc | Note |\n| --- | --- |\n| x | as said⟨1:1⟩ |')
  })

  test('side by side, a cross-reference keeps #351\'s separators and spacing', () => {
    assert.equal(word('x [a](source:a), [a](source:a) y'), 'x⟦1⟧^[a]⟦/1⟧, ⟨1:1⟩ y')
    assert.equal(word('x [a](source:a),[a](source:a) y'), 'x⟦1⟧^[a]⟦/1⟧, ⟨1:1⟩ y')
    assert.equal(word('x [a](source:a)[a](source:a) y'), 'x⟦1⟧^[a]⟦/1⟧ ⟨1:1⟩ y')
    assert.equal(word('x ([a](source:a); [b](source:b)) y ([b](source:b); [a](source:a)).'), 'x⟦1⟧^[a]⟦/1⟧ ⟦2⟧^[b]⟦/2⟧ y⟨2:2⟩ ⟨1:1⟩.')
    assert.equal(word('x [b](source:b), [a](source:a) y [a](source:a)'), 'x^[b], ⟦1⟧^[a]⟦/1⟧ y⟨1:2⟩', 'a bookmarked note after a note keeps its space')
    assert.equal(word('x [a](source:a) y [a](source:a)x^2^ z'), 'x⟦1⟧^[a]⟦/1⟧ y⟨1:1⟩x ^2^ z', 'and a cross-reference is kept from the writer\'s own ^')
  })

  test('the numbers are counted over the whole document, so a footnote in front of the Fields moves them on', () => {
    const fields = sourceCitationsForWord('a [A](source:a) b [A](source:a)')
    assert.equal(readable(numberCitationCrossReferences(`Cover^[x]\n\n${fields}`)), 'Cover^[x]\n\na⟦1⟧^[A]⟦/1⟧ b⟨1:2⟩')
    assert.equal(numberCitationCrossReferences(numberCitationCrossReferences(fields)), fields, 'counting again changes nothing')
    assert.equal(numberCitationCrossReferences('No ^[cross-reference] here.'), 'No ^[cross-reference] here.')
  })

  test('the Pandoc this server converts with makes one footnote per reference, and each cross-reference shows the right number in the Footnote Reference style', async () => {
    const { execFileSync } = await import('node:child_process')
    const markdown = [
      'Built from it ([A](source:a)). See [B](source:b), [A](source:a); and the author\'s own^[Mine.] note[^n].',
      '',
      '- [B](source:b): the list labels it',
      '',
      'Again [Gantry hosting](source:h) and [Gantry hosting, Constraints](source:h) ([B](source:b); [Gantry hosting, Constraints](source:h)).',
      '',
      '[^n]: Defined.',
    ].join('\n')
    const dir = mkdtempSync(join(tmpdir(), 'gantry-noteref-'))
    try {
      const docx = join(dir, 'out.docx')
      execFileSync('pandoc', ['-f', 'markdown', '-t', 'docx', '-o', docx], { input: sourceCitationsForWord(markdown) })
      const marks = footnoteMarks(docxPart(docx, 'word/document.xml'))
      const notes = footnotes(docxPart(docx, 'word/footnotes.xml'))
      assert.deepEqual(notes.map((n) => n.text), ['A', 'B', 'Mine.', 'Defined.', 'Gantry hosting', 'Gantry hosting, Constraints'])
      assert.deepEqual(
        marks.map((m) => (m.kind === 'footnote' ? m.number : `→${m.shown}`)),
        [1, 2, '→1', 3, 4, 5, 6, '→2', '→6']
      )
      for (const m of marks.filter((m) => m.kind === 'reference')) {
        assert.equal(m.shown, String(m.refersTo), `${m.bookmark} shows the number of the footnote it refers to`)
        assert.equal(m.style, 'FootnoteReference')
        assert.equal(m.switches, '\\f \\h')
      }
      const text = docxPart(docx, 'word/document.xml')
      assert.doesNotMatch(text, /w:dirty/, 'no field is marked for Word to update')
      assert.doesNotMatch(docxPart(docx, 'word/settings.xml'), /updateFields/, 'nothing asks Word to update fields when it opens')
      assert.match(text, /B: the list labels it/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('Pandoc 2 reads each of them as a footnote or a cross-reference, with nothing left as a superscript', async () => {
    const { execFileSync } = await import('node:child_process')
    const cases = [
      ['x [a](source:a), [a](source:a) y', 1],
      ['x [a](source:a),[a](source:a) y', 1],
      ['x [a](source:a)[a](source:a) y', 1],
      ['x [b](source:b),[a](source:a) y [a](source:a)', 2],
      ['x ([a](source:a); [b](source:b)) y ([b](source:b); [a](source:a)).', 2],
      ['x [a](source:a) y [a](source:a)x^2^ z', 1],
      ['it is O(n^2) [a](source:a) and O(n^2) [a](source:a).', 1],
      ['x [[a](source:a)]{#gf_m_f} y [[a](source:a)]{#gf_m_g}', 1],
    ]
    for (const [markdown, notes] of cases) {
      const word = sourceCitationsForWord(markdown)
      const ast = JSON.stringify(JSON.parse(execFileSync('pandoc', ['-f', 'markdown', '-t', 'json'], { input: word, encoding: 'utf8' })).blocks)
      assert.equal(ast.match(/"t":"Note"/g)?.length ?? 0, notes, `${markdown} → ${word}`)
      assert.equal(ast.match(/NOTEREF/g)?.length ?? 0, (word.match(/NOTEREF/g) ?? []).length, `${markdown}: every cross-reference reaches Word`)
      assert.doesNotMatch(ast, /"t":"Superscript","c":\[\{"t":"(?:RawInline|Str","c":"[[,;])/, `${markdown} → ${word}`)
      assert.doesNotMatch(ast, /"\^\[|"\[\^/, `${markdown}: no note left as literal text`)
      if (markdown.includes('^2^')) assert.match(ast, /"t":"Superscript","c":\[\{"t":"Str","c":"2"\}\]/, 'the writer\'s own superscript is still one')
    }
  })
})

describe('a reference cited again, beside code, stray backticks and the author\'s own footnotes (#353)', () => {
  // Converted by both Pandocs: the one this server runs and the browser's pandoc-wasm, which every render request may use.
  // Each comes back as the body's text, its footnote marks (a footnote's number, or `→shown` for a cross-reference), the
  // footnotes' text, and the cross-references whose shown number is not the number of the footnote they point at.
  const convertBoth = async (word) => {
    const { execFileSync } = await import('node:child_process')
    const { convert } = await import('../node_modules/pandoc-wasm/src/index.node.js')
    const dir = mkdtempSync(join(tmpdir(), 'gantry-noteref-'))
    try {
      const native = join(dir, 'native.docx')
      execFileSync('pandoc', ['-f', 'markdown', '-t', 'docx', '-o', native], { input: word })
      const wasm = join(dir, 'wasm.docx')
      const converted = await convert({ from: 'markdown', to: 'docx', 'output-file': 'output.docx' }, word, {})
      writeFileSync(wasm, new Uint8Array(await converted.files['output.docx'].arrayBuffer()))
      return [native, wasm].map((docx) => {
        const xml = docxPart(docx, 'word/document.xml')
        const body = xml.slice(xml.indexOf('<w:body'))
        const marks = footnoteMarks(xml)
        return {
          docx,
          xml,
          text: [...body.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((t) => t[1]).join(''),
          marks: marks.map((m) => (m.kind === 'footnote' ? m.number : `→${m.shown}`)),
          wrong: marks.filter((m) => m.kind === 'reference' && m.shown !== String(m.refersTo)),
          notes: footnotes(docxPart(docx, 'word/footnotes.xml')).map((n) => n.text),
        }
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('a citation straight after a code span keeps the code, and its bookmark or cross-reference is still raw OpenXML', async () => {
    const markdown = 'Set in `gantry.yaml` [Gantry hosting](source:h).\n\nThe limit is in `limits.ts` [Gantry hosting](source:h), as before.'
    const word = sourceCitationsForWord(markdown)
    // An empty Span between them, which prints nothing: backticks side by side would be read as one longer delimiter.
    assert.doesNotMatch(word, /```/)
    assert.match(word, /`gantry\.yaml`\[\]\{\}``<w:bookmarkStart /)
    for (const docx of await convertBoth(word)) {
      assert.match(docx.text, /^Set in gantry\.yaml\. *The limit is in limits\.ts1?, as before\.$/, docx.docx)
      assert.deepEqual(docx.marks, [1, '→1'], docx.docx)
      assert.deepEqual(docx.wrong, [], docx.docx)
      assert.doesNotMatch(docx.xml, /<w:p(?: [^>]*)?>[^<]/, `${docx.docx}: no bare text in a paragraph`)
    }
  })

  test('a stray backtick, in another paragraph or in the same one, does not upset the bookmarks or the numbers', async () => {
    const markdown = "Press the ` key to go.\n\nSee [A](source:a) and^[mine] then [A](source:a).\n\nDon`t miss [B](source:b), cited again [B](source:b) and ``x`` too."
    for (const docx of await convertBoth(sourceCitationsForWord(markdown))) {
      assert.deepEqual(docx.marks, [1, 2, '→1', 3, '→3'], docx.docx)
      assert.deepEqual(docx.wrong, [], docx.docx)
      assert.deepEqual(docx.notes, ['A', 'mine', 'B'], docx.docx)
      assert.match(docx.text, /Press the ` key to go\./, docx.docx)
      assert.match(docx.text, /Don`t miss, cited again3 and x too\./, docx.docx)
    }
    // Over the whole document too: a stray backtick in what goes in front of the Fields.
    const fields = sourceCitationsForWord('See [A](source:a) and [A](source:a).')
    assert.match(numberCitationCrossReferences(`Don\`t^[cover]\n\n${fields}`), /<w:t>2<\/w:t>/)
  })

  test("a reference first cited in an author's own footnote is footnoted where it is next cited in the text, and the footnote shows its number", async () => {
    const markdown = 'Text^[see [A](source:a) for it] and [A](source:a) then [A](source:a).'
    for (const docx of await convertBoth(sourceCitationsForWord(markdown))) {
      assert.deepEqual(docx.marks, [1, 2, '→2'], docx.docx)
      assert.deepEqual(docx.wrong, [], docx.docx)
      assert.deepEqual(docx.notes, ['see 2 for it', 'A'], docx.docx)
    }
    // A footnote definition is a note too, and a reference cited only in notes is the note it was.
    assert.equal(sourceCitationsForWord('Text^[see [A](source:a)].'), 'Text^[see ^[A]].')
    const defined = sourceCitationsForWord('Text[^n] and [A](source:a).\n\n[^n]: As [A](source:a) says.')
    for (const docx of await convertBoth(defined)) {
      assert.deepEqual(docx.marks, [1, 2], docx.docx)
      assert.deepEqual(docx.notes, ['As2 says.', 'A'], docx.docx)
    }
  })

  test('a ^[ that Pandoc makes no footnote of, in a link address, an HTML tag or math, is not counted', async () => {
    const markdown = 'See [site](http://x.org/^[a]) and <span title="^[x]">s</span> and $x^[1]$ and [A](source:a) and [A](source:a).'
    for (const docx of await convertBoth(sourceCitationsForWord(markdown))) {
      assert.deepEqual(docx.marks, [1, '→1'], docx.docx)
      assert.deepEqual(docx.wrong, [], docx.docx)
    }
  })
})

describe('the Sources appendix', () => {
  const entries = [
    { id: 'client-brief', title: 'Client brief', filename: 'Client brief v3.docx', uploadedAt: '2026-03-04T09:30:00.000Z' },
    { id: 'old-notes', title: 'Old notes', filename: 'notes.txt', uploadedAt: '2026-01-15T00:00:00.000Z', removedAt: '2026-02-01T00:00:00.000Z' },
    { id: 'never-cited', title: 'Never cited', filename: 'other.pdf', uploadedAt: '2026-01-01T00:00:00.000Z' },
  ]

  test('lists only the documents the Artefact cites, each with its title, original filename and upload date', () => {
    const appendix = buildSourceAppendix('[a](source:client-brief)', entries)
    assert.equal(appendix, '# Sources\n\n| Document | File | Added |\n| --- | --- | --- |\n| Client brief | Client brief v3.docx | 4 Mar 2026 |\n')
    assert.doesNotMatch(appendix, /Never cited/)
  })

  test('a document fetched from a web address shows its title, the address and "retrieved <date>" in place of the filename and upload date (#318)', () => {
    const fetched = { id: 'vendor-api', title: 'Vendor API guide', filename: 'Vendor API guide.html', uploadedAt: '2026-11-03T09:00:05.000Z', origin: { address: 'https://vendor.example.com/api', finalAddress: 'https://docs.vendor.example.com/api', fetchedAt: '2026-11-03T09:00:00.000Z' } }
    const appendix = buildSourceAppendix('[a](source:vendor-api) [b](source:client-brief)', [...entries, fetched])
    assert.match(appendix, /\| Vendor API guide \| https:\/\/vendor\.example\.com\/api \| retrieved 3 Nov 2026 \|/)
    assert.match(appendix, /\| Client brief \| Client brief v3\.docx \| 4 Mar 2026 \|/, 'an upload is listed as before')
    assert.doesNotMatch(appendix, /Vendor API guide\.html/)
  })

  test('a removed document is still listed, marked removed', () => {
    const appendix = buildSourceAppendix('[a](source:old-notes) [b](source:client-brief)', entries)
    assert.match(appendix, /\| Old notes \(removed\) \| notes\.txt \| 15 Jan 2026 \|/)
    assert.ok(appendix.indexOf('Old notes') < appendix.indexOf('Client brief'), 'in the order first cited')
  })

  test('a document the manifest does not list is left out, and nothing cited means no list at all', () => {
    assert.equal(buildSourceAppendix('[a](source:unknown)', entries), '')
    assert.equal(buildSourceAppendix('no citations here', entries), '')
    assert.equal(buildSourceAppendix('[a](source:client-brief)', []), '')
  })

  test('a title or filename holding a pipe cannot break the table', () => {
    const appendix = buildSourceAppendix('[a](source:x)', [{ id: 'x', title: 'A | B', filename: 'a|b.txt', uploadedAt: '2026-03-04T00:00:00Z' }])
    assert.match(appendix, /\| A \\\| B \| a\\\|b\.txt \|/)
  })
})

describe('the validator knows the setting', () => {
  test('only a real true or false is accepted', () => {
    assert.equal(sourceAppendixProblem('soap', undefined), null)
    assert.equal(sourceAppendixProblem('soap', true), null)
    assert.equal(sourceAppendixProblem('soap', false), null)
    assert.deepEqual(sourceAppendixProblem('soap', 'yes'), {
      type: 'invalid-source-appendix',
      message: 'Artefact "soap" sets "source-appendix" to "yes" — it must be true or false',
    })
    assert.equal(sourceAppendixProblem('soap', 1).type, 'invalid-source-appendix')
  })

  const structure = (artefactExtra) => ({
    id: 'tiny',
    version: 1,
    stages: [{ id: 's', title: 'S', purpose: 'p', gate: 'g', modules: ['m'] }],
    artefacts: [{ id: 'doc', title: 'Doc', purpose: 'p', template: 'templates/doc.md.tmpl', gate: 'g', requires: ['m.f'], ...artefactExtra }],
    modules: [{ id: 'm', title: 'M', fields: [{ id: 'f', title: 'F', type: 'markdown', required: true }] }],
  })

  test('a bad value is reported when a Definition is validated (server and Local Workspace)', () => {
    const types = (problems) => problems.map((p) => p.type)
    assert.deepEqual(types(findDefinitionProblemsInStructure(structure({ sourceAppendix: true }))), [])
    assert.deepEqual(types(findDefinitionProblemsInStructure(structure({ 'source-appendix': 'yes' }))), ['invalid-source-appendix'])
    assert.deepEqual(types(findDefinitionProblemsInStructure(structure({ sourceAppendix: 'yes' }))), ['invalid-source-appendix'])
    assert.ok(types(findLocalDefinitionProblems(structure({ sourceAppendix: 'yes' }))).includes('invalid-source-appendix'))
    assert.ok(!types(findLocalDefinitionProblems(structure({ sourceAppendix: true }))).includes('invalid-source-appendix'))
  })

  test('the setting round-trips through the Definition files, and is projected only when switched on', () => {
    const written = buildDefinitionYamlObject('tiny', 1, 'draft', structure({ sourceAppendix: true }), {})
    assert.equal(written.artefacts[0]['source-appendix'], true)
    const off = buildDefinitionYamlObject('tiny', 1, 'draft', structure({}), {})
    assert.ok(!('source-appendix' in off.artefacts[0]))
  })

  test('design v1 and v2 leave it off, and design v3 (#308) turns it on for every Artefact', () => {
    for (const version of [1, 2]) {
      const definition = loadDefinition('design', { definitionsDir: 'definitions', version })
      assert.ok(definition.artefacts.every((a) => a.sourceAppendix === undefined), `design v${version}`)
    }
    const v3 = loadDefinition('design', { definitionsDir: 'definitions', version: 3 })
    assert.ok(v3.artefacts.length > 0 && v3.artefacts.every((a) => a.sourceAppendix === true), 'design v3')
  })
})

describe('Use as image', () => {
  test('only a PNG or JPEG can be used as an image', () => {
    assert.deepEqual([...ASSET_IMAGE_EXTENSIONS], ['.png', '.jpg', '.jpeg'])
    assert.equal(canUseSourceAsImage('Whiteboard.png'), true)
    assert.equal(canUseSourceAsImage('Photo.JPG'), true)
    assert.equal(canUseSourceAsImage('anim.gif'), false)
    assert.equal(canUseSourceAsImage('Brief.docx'), false)
    assert.equal(canUseSourceAsImage('png'), false)
  })

  test('a Local Workspace copy is named so it can be typed into assets/<name>, and never overwrites an image', () => {
    assert.equal(assetFilenameForSource('Whiteboard sketch (v2).PNG', []), 'Whiteboard-sketch-v2.png')
    assert.equal(assetFilenameForSource('Whiteboard.png', ['whiteboard.png']), 'Whiteboard-2.png')
    assert.equal(assetFilenameForSource('Whiteboard.png', ['Whiteboard.png', 'Whiteboard-2.png']), 'Whiteboard-3.png')
    assert.equal(assetFilenameForSource('!!!.jpg', []), 'image.jpg')
  })

  test('the server copy is a new Asset that keeps no link to the document', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gantry-useasimage-'))
    try {
      const png = Buffer.from('89504e470d0a1a0a', 'hex')
      const asset = createAsset('inst', { filename: 'Whiteboard.png', buffer: png, name: 'Whiteboard', uploadedBy: 'a.architect' }, { instancesDir: dir, copiedFromSource: 'sources/Whiteboard.png' })
      assert.equal(asset.name, 'Whiteboard')
      assert.equal(asset.source, 'sources/Whiteboard.png')
      assert.match(asset.filename, /\.png$/)
      assert.deepEqual(readFileSync(join(dir, 'inst', 'assets', asset.filename)), png)
      // An upload's own body can never claim a Source document as its origin: the usual web address is still required.
      assert.throws(() => createAsset('inst', { filename: 'x.png', buffer: png, source: 'sources/x.png' }, { instancesDir: dir }), /valid URL/)
      assert.throws(() => createAsset('inst', { filename: 'x.png', buffer: png }, { instancesDir: dir, copiedFromSource: 'elsewhere/x.png' }), /Source location is required/)
      // Only an image type: the Asset rules still apply.
      assert.throws(() => createAsset('inst', { filename: 'Brief.docx', buffer: png }, { instancesDir: dir, copiedFromSource: 'sources/Brief.docx' }), /Unsupported image file type/)
      assert.equal(listAssets({ modules: new Map() }, 'inst', { instancesDir: dir }).length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- The render ----------------------------------------------------------------------------------------------------

const SLUG = 'examples'
const EXAMPLE = 'workspaces/examples/kiwi-cover-mutual'
const MANIFEST = [
  { id: 'client-brief', filename: 'Client brief v3.docx', title: 'Client brief', uploadedBy: 'a.architect', uploadedAt: '2026-03-04T09:30:00.000Z', size: 1000 },
  { id: 'old-notes', filename: 'notes.txt', title: 'Old notes', uploadedBy: 'a.architect', uploadedAt: '2026-01-15T00:00:00.000Z', size: 10, removedAt: '2026-02-01T00:00:00.000Z', removedBy: 'a.architect' },
  { id: 'never-cited', filename: 'other.pdf', title: 'Never cited', uploadedBy: 'a.architect', uploadedAt: '2026-01-01T00:00:00.000Z', size: 10 },
]
const CITED = 'Median time to payment is 12.4 working days [Client brief, p. 4](source:client-brief), confirmed in the [notes](source:old-notes).'

// A scratch copy of the example Instance (design v3) with a citation in its Background, a Source documents manifest, and a copy of the bundled Definitions whose Solution on a Page (and only it) turns the appendix on when `appendix` is true.
async function withCitingExample({ appendix, manifest = MANIFEST, citing = CITED }, fn) {
  const root = mkdtempSync(join(tmpdir(), 'gantry-citations-'))
  try {
    const instancesDir = join(root, 'instances')
    const definitionsDir = join(root, 'definitions')
    cpSync(EXAMPLE, join(instancesDir, SLUG), { recursive: true })
    rmSync(join(instancesDir, SLUG, 'out'), { recursive: true, force: true })
    const instanceYaml = readFileSync(join(instancesDir, SLUG, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3')
    writeFileSync(join(instancesDir, SLUG, 'instance.yaml'), instanceYaml)
    const backgroundPath = join(instancesDir, SLUG, 'modules', 'background.md')
    const background = readFileSync(backgroundPath, 'utf8')
    const cited = background.replace(/\n## Affected domains/, `\n${citing}\n\n## Affected domains`)
    assert.notEqual(cited, background, 'the citation lands in the Background')
    writeFileSync(backgroundPath, cited)
    cpSync('definitions/design', join(definitionsDir, 'design'), { recursive: true })
    // Design v3 turns the appendix on for every Artefact (#308). Take it out of all of them, then put it back on the Solution on a Page alone when `appendix` is true.
    const defPath = join(definitionsDir, 'design', '3', 'definition.yaml')
    const text = readFileSync(defPath, 'utf8')
    assert.match(text, /^    source-appendix: true$/m)
    const without = text.replace(/^    source-appendix: true\n/gm, '')
    writeFileSync(defPath, without)
    if (appendix) {
      const edited = without.replace('    diagram-captions: true\n', '    diagram-captions: true\n    source-appendix: true\n')
      assert.notEqual(edited, without)
      writeFileSync(defPath, edited)
    }
    // #310: the example brings its own Source documents; an Instance "with no Source documents" has none.
    if (!manifest) rmSync(join(instancesDir, SLUG, 'sources'), { recursive: true, force: true })
    if (manifest) {
      mkdirSync(join(instancesDir, SLUG, 'sources'), { recursive: true })
      writeFileSync(join(instancesDir, SLUG, 'sources', 'manifest.yaml'), stringifyYAML(manifest))
    }
    return await fn({ instancesDir, definitionsDir })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// A rendered .docx's body text, with each footnote mark written "[<id>]" where it sits, and its footnotes in the order they are
// cited: `{ id, text, xml }` each, leaving out Word's separator notes.
async function wordParts(docxPath) {
  const { execFileSync } = await import('node:child_process')
  const xml = execFileSync('unzip', ['-p', docxPath, 'word/document.xml'], { encoding: 'utf8' })
  const textOf = (part) => [...part.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:footnoteReference w:id="(\d+)" ?\/>/g)].map((m) => m[1] ?? `[${m[2]}]`).join('')
  const notesXml = execFileSync('unzip', ['-p', docxPath, 'word/footnotes.xml'], { encoding: 'utf8' })
  const byId = new Map([...notesXml.matchAll(/<w:footnote(?: [^>]*)? w:id="(\d+)"(?: [^>]*)?>([\s\S]*?)<\/w:footnote>/g)].filter((m) => !/w:type="(?:continuation)?[sS]eparator"/.test(m[0].slice(0, m[0].indexOf('>')))).map((m) => [m[1], m[2]]))
  // Pandoc keeps "p. 4" together with a no-break space; read as an ordinary one.
  const footnotes = [...xml.matchAll(/<w:footnoteReference w:id="(\d+)"/g)].map((m) => ({ id: m[1], xml: byId.get(m[1]), text: textOf(byId.get(m[1]) ?? '').replace(/ /g, ' ').trim() }))
  return { xml, text: textOf(xml), footnotes }
}

describe('rendering', () => {
  test('Word prints a citation as a footnote with no link, and the exported .md keeps it as written', async () => {
    await withCitingExample({ appendix: false }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, wordTags: false })
      assert.match(result.markdown, /\[Client brief, p\. 4\]\(source:client-brief\)/)
      assert.match(result.docxMarkdown, /12\.4 working days\^\[Client brief, p\. 4\], confirmed in the\^\[notes\]\./)
      assert.doesNotMatch(result.docxMarkdown, /source:/)
    })
  })

  test('the same holds when the Word text carries its Field tags', async () => {
    await withCitingExample({ appendix: false }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true })
      assert.match(result.docxMarkdown, /\^\[Client brief, p\. 4\]/)
      assert.doesNotMatch(result.docxMarkdown, /\]\(source:/)
    })
  })

  test('the real .docx has the words as footnotes and no hyperlink to the document', async () => {
    await withCitingExample({ appendix: false }, async ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      const { xml, text, footnotes } = await wordParts(result.docxPath)
      const ours = /12\.4 working days\[(\d+)\], confirmed in the\[(\d+)\]\./.exec(text)
      assert.ok(ours, 'a footnote mark where each citation was')
      assert.deepEqual(ours.slice(1).map((id) => footnotes.find((f) => f.id === id)?.text), ['Client brief, p. 4', 'notes'])
      assert.doesNotMatch(xml, /source:/)
      const { execFileSync } = await import('node:child_process')
      const rels = execFileSync('unzip', ['-p', result.docxPath, 'word/_rels/document.xml.rels'], { encoding: 'utf8' })
      assert.doesNotMatch(rels, /source:/)
    })
  })

  // #351: the acceptance examples, through the compile step and a real Pandoc conversion, with the Field tags on as they are in use.
  test('the .docx carries one real Word footnote per citation in running text, in the Footnote styles, and plain words where a citation labels a list item', async () => {
    const citing = [
      'It was built from it ([operating model](source:client-brief)). See [Client brief, p. 4](source:client-brief) for the figures ([a](source:old-notes); [b](source:client-brief)).',
      '',
      '- [Client brief](source:client-brief): scope, costing',
    ].join('\n')
    await withCitingExample({ appendix: true, citing }, async ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      const { xml, text, footnotes } = await wordParts(result.docxPath)
      const ours = /It was built from it\[(\d+)\]\. See\[(\d+)\] for the figures\[(\d+)\] \[(\d+)\]\./.exec(text)
      assert.ok(ours, `a mark where each citation was, and no brackets or semicolon left: ${text.slice(text.indexOf('It was built'), text.indexOf('It was built') + 80)}`)
      const notes = ours.slice(1).map((id) => footnotes.find((f) => f.id === id))
      assert.deepEqual(notes.map((f) => f?.text), ['operating model', 'Client brief, p. 4', 'a', 'b'])
      // One footnote in word/footnotes.xml for each mark in the text (the example's own citations among them).
      assert.equal((xml.match(/<w:footnoteReference /g) ?? []).length, footnotes.length)
      assert.equal(new Set(footnotes.map((f) => f.id)).size, footnotes.length)
      assert.ok(footnotes.every((f) => f.xml))
      for (const f of notes) {
        assert.match(f.xml, /<w:pStyle w:val="FootnoteText" ?\/>/, 'the reference document\'s Footnote Text style')
        assert.match(f.xml, /<w:rStyle w:val="FootnoteReference" ?\/>/, 'and its Footnote Reference style for the number')
      }
      assert.match(text, /Client brief: scope, costing/, 'the References-style item prints its words')
      assert.doesNotMatch(text, /\(Client brief\)|\(operating model\)/)
      // The Sources appendix is unchanged: the cited documents, once each.
      assert.match(text, /Client brief\s*Client brief v3\.docx\s*4 Mar 2026\s*Old notes \(removed\)\s*notes\.txt\s*15 Jan 2026/)
    })
  })

  // #353: through the compile step and a real Pandoc conversion. The example's Full SOAP cites "Client brief, p. 2" in the
  // Background and again in the Design basis; here the Background cites it first, with an author's own footnote after it.
  test('a reference cited in several Fields and Modules is one footnote, and every later citation shows its number on open, with an author\'s footnote between', async () => {
    const citing = "Targets are set [Client brief, p. 2](source:client-brief), with the author's own^[A note of the author.] note between, and again [Client brief, p. 2](source:client-brief)."
    await withCitingExample({ appendix: false, citing }, async ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap-full', { instancesDir, definitionsDir })
      const marks = footnoteMarks(docxPart(result.docxPath, 'word/document.xml'))
      const notes = footnotes(docxPart(result.docxPath, 'word/footnotes.xml'))
      const words = notes.map((n) => n.text)
      assert.deepEqual(words, [...new Set(words)], `one footnote per reference: ${words.join(' | ')}`)
      assert.equal(marks.filter((m) => m.kind === 'footnote').length, notes.length)
      const brief = marks.find((m) => m.kind === 'footnote' && notes.find((n) => n.id === m.id)?.text === 'Client brief, p. 2')
      const author = marks.find((m) => m.kind === 'footnote' && notes.find((n) => n.id === m.id)?.text === 'A note of the author.')
      assert.ok(brief && author, `both footnotes are there: ${words.join(' | ')}`)
      assert.equal(author.number, brief.number + 1, "the author's footnote is numbered after the citation's")
      const again = marks.filter((m) => m.kind === 'reference' && m.refersTo === brief.number)
      assert.ok(again.length >= 2, 'the later citations, in this Field and in the Design basis, are cross-references to it')
      assert.ok(again.some((m) => m.bookmarks.includes('design-basis')), 'one of them in another Module')
      for (const m of marks.filter((m) => m.kind === 'reference')) {
        assert.equal(m.shown, String(m.refersTo), `${m.bookmark} shows its footnote's number before any update of fields`)
        assert.equal(m.style, 'FootnoteReference')
      }
    })
  })

  test('with the setting off there is no Sources list', async () => {
    await withCitingExample({ appendix: false }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, wordTags: false })
      assert.doesNotMatch(result.markdown, /^# Sources$/m)
      assert.doesNotMatch(result.docxMarkdown, /^# Sources$/m)
    })
  })

  test('with the setting on the Artefact ends with a Sources list of only the documents it cites, removed ones marked', async () => {
    await withCitingExample({ appendix: true }, ({ instancesDir, definitionsDir }) => {
      for (const options of [{ wordTags: false }, {}]) {
        const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, ...options })
        for (const text of [result.markdown, result.docxMarkdown]) {
          const appendix = text.slice(text.lastIndexOf('# Sources'))
          assert.equal(
            appendix.trim(),
            [
              '# Sources',
              '',
              '| Document | File | Added |',
              '| --- | --- | --- |',
              '| Client brief | Client brief v3.docx | 4 Mar 2026 |',
              '| Old notes (removed) | notes.txt | 15 Jan 2026 |',
            ].join('\n')
          )
          assert.ok(text.trimEnd().endsWith('15 Jan 2026 |'), 'the list is the last thing in the document')
          assert.ok(!text.includes('Never cited'))
        }
      }
    })
  })

  test('an Instance with no Source documents has no list, and a citation of an unknown id still prints its words', async () => {
    await withCitingExample({ appendix: true, manifest: null }, ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, wordTags: false })
      assert.doesNotMatch(result.docxMarkdown, /^# Sources$/m)
      assert.match(result.docxMarkdown, /\^\[Client brief, p\. 4\]/)
    })
  })

  test('an Artefact that cites nothing renders exactly as it did, with the setting on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gantry-nocite-'))
    try {
      const instancesDir = join(root, 'instances')
      cpSync(EXAMPLE, join(instancesDir, SLUG), { recursive: true })
      rmSync(join(instancesDir, SLUG, 'out'), { recursive: true, force: true })
      writeFileSync(join(instancesDir, SLUG, 'instance.yaml'), readFileSync(join(instancesDir, SLUG, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3'))
      removeCitations(join(instancesDir, SLUG))
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir: 'definitions', dryRun: true, wordTags: false })
      assert.doesNotMatch(result.docxMarkdown, /# Sources/)
      assert.equal(result.docxMarkdown.includes('source:'), false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('a Local Workspace render request', () => {
  const payload = (extra = {}) => {
    const instanceYaml = readFileSync(join(EXAMPLE, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3')
    const moduleFiles = {}
    for (const file of readdirSync(join(EXAMPLE, 'modules'))) {
      const text = readFileSync(join(EXAMPLE, 'modules', file), 'utf8')
      moduleFiles[file.replace(/\.md$/, '')] = file === 'background.md' ? text.replace(/\n## Affected domains/, `\n${CITED}\n\n## Affected domains`) : text
    }
    const assets = readdirSync(join(EXAMPLE, 'assets')).map((file) => ({ id: file, base64: readFileSync(join(EXAMPLE, 'assets', file)).toString('base64') }))
    return { definitionId: 'design', definitionVersion: 3, instanceYaml, moduleFiles, assets, artefact: 'soap', ...extra }
  }
  const entry = (id) => {
    const { id: _id, size: _size, uploadedBy: _by, removedBy: _rb, ...rest } = MANIFEST.find((e) => e.id === id)
    return { id, ...rest }
  }

  test('the manifest entries of the cited documents give Word the titles, and nothing else of a document travels', async () => {
    const result = await runLocalWorkspaceCompute('compile', payload({ sources: [entry('client-brief'), entry('old-notes')] }), { definitionsDir: 'definitions' })
    assert.match(result.docxMarkdown, /12\.4 working days\^\[Client brief, p\. 4\], confirmed in the\^\[notes\]\./)
    assert.match(result.markdown, /\(source:client-brief\)/)
  })

  test('without them a citation still prints its words', async () => {
    const result = await runLocalWorkspaceCompute('compile', payload(), { definitionsDir: 'definitions' })
    assert.match(result.docxMarkdown, /\^\[Client brief, p\. 4\]/)
  })

  test('a request that names an unsafe id, or too many entries, is refused before anything is written', async () => {
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: [{ id: '../x', filename: 'x.txt' }] }), { definitionsDir: 'definitions' }), LocalWorkspaceRequestError)
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: 'nope' }), { definitionsDir: 'definitions' }), /sources must be an array/)
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: [{ id: 'a', filename: 7 }] }), { definitionsDir: 'definitions' }), /must carry a filename/)
    const many = Array.from({ length: 501 }, (_, i) => ({ id: `s${i}`, filename: 'x.txt' }))
    await assert.rejects(runLocalWorkspaceCompute('compile', payload({ sources: many }), { definitionsDir: 'definitions' }), (err) => err.status === 413)
  })
})

// --- #319: a code repository in the render -------------------------------------------------------------------------
// A repository is cited by a file at a commit. Word prints a footnote of the words, the file and the short commit (#351); the Sources appendix gives its title, address, branch and the
// commits cited, through the real render (lib/render.js) on a server workspace and through a Local Workspace's compute request.

describe('a code repository in the render (#319)', () => {
  const HEAD = 'c0ffee1234567890abcdef1234567890abcdef12'
  const OLD = '0ld0ld1234567890abcdef1234567890abcdef12'
  const repository = { provider: 'github', location: { owner: 'acme', repository: 'billing-api' }, branch: 'main' }
  const REPO_MANIFEST = [...MANIFEST, { id: 'billing-api', title: 'Billing API', uploadedBy: 'a.architect', uploadedAt: '2026-11-01T00:00:00.000Z', repository }]
  const REPO_CITED = `${CITED} Orders are capped [Billing API, limits](source:billing-api?path=src/orders/limits.ts&commit=${HEAD}) as the [readme](source:billing-api?path=README.md&commit=${OLD}) says.`
  const APPENDIX = [
    '# Sources',
    '',
    '| Document | File | Added |',
    '| --- | --- | --- |',
    '| Client brief | Client brief v3.docx | 4 Mar 2026 |',
    '| Old notes (removed) | notes.txt | 15 Jan 2026 |',
    '| Billing API | https://github.com/acme/billing-api/tree/main | branch main, commits c0ffee1, 0ld0ld1 |',
  ].join('\n')
  const appendixOf = (text) => text.slice(text.lastIndexOf('# Sources')).trim()

  test('Word prints a repository citation as a footnote naming the file and commit, and the Sources appendix (Word and .md) gives its title, address, branch and commits cited', async () => {
    await withCitingExample({ appendix: true, manifest: REPO_MANIFEST, citing: REPO_CITED }, ({ instancesDir, definitionsDir }) => {
      for (const options of [{ wordTags: false }, {}]) {
        const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, ...options })
        assert.match(result.markdown, new RegExp(`\\[Billing API, limits\\]\\(source:billing-api\\?path=src/orders/limits\\.ts&commit=${HEAD}\\)`), 'the .md keeps the citation as written')
        assert.match(result.docxMarkdown, /Orders are capped\^\[Billing API, limits, src\/orders\/limits\.ts, at commit c0ffee1\] as the\^\[readme, README\.md, at commit 0ld0ld1\] says\./)
        assert.doesNotMatch(result.docxMarkdown, /\]\(source:/)
        for (const text of [result.markdown, result.docxMarkdown]) assert.equal(appendixOf(text), APPENDIX)
      }
    })
  })

  test('the real .docx carries the appendix row, a footnote naming the file and short commit, and no link to the repository citation', async () => {
    await withCitingExample({ appendix: true, manifest: REPO_MANIFEST, citing: REPO_CITED }, async ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      const { xml, text, footnotes } = await wordParts(result.docxPath)
      const ours = /Orders are capped\[(\d+)\] as the\[(\d+)\] says\./.exec(text)
      assert.ok(ours, 'a footnote mark where each citation was')
      assert.deepEqual(ours.slice(1).map((id) => footnotes.find((f) => f.id === id)?.text), ['Billing API, limits, src/orders/limits.ts, at commit c0ffee1', 'readme, README.md, at commit 0ld0ld1'])
      assert.match(text, /Billing API.*https:\/\/github\.com\/acme\/billing-api\/tree\/main.*branch main, commits c0ffee1, 0ld0ld1/)
      assert.doesNotMatch(xml, /source:/)
    })
  })

  test('a Local Workspace render request takes a repository entry with no filename and prints the same appendix', async () => {
    const instanceYaml = readFileSync(join(EXAMPLE, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3')
    const moduleFiles = {}
    for (const file of readdirSync(join(EXAMPLE, 'modules'))) {
      const text = readFileSync(join(EXAMPLE, 'modules', file), 'utf8')
      moduleFiles[file.replace(/\.md$/, '')] = file === 'background.md' ? text.replace(/\n## Affected domains/, `\n${REPO_CITED}\n\n## Affected domains`) : text
    }
    const assets = readdirSync(join(EXAMPLE, 'assets')).map((file) => ({ id: file, base64: readFileSync(join(EXAMPLE, 'assets', file)).toString('base64') }))
    // What web/app.js's buildLocalComputePayload sends: the cited entries' id, filename, title, dates, origin and (#319) pointer.
    const sources = REPO_MANIFEST.filter((e) => e.id !== 'never-cited').map(({ id, filename, title, uploadedAt, removedAt, origin, repository }) => ({ id, filename, title, uploadedAt, removedAt, origin, repository }))
    assert.equal(sources.find((s) => s.id === 'billing-api').filename, undefined)
    const request = (list) => ({ definitionId: 'design', definitionVersion: 3, instanceYaml, moduleFiles, assets, artefact: 'soap', sources: list })
    const result = await runLocalWorkspaceCompute('compile', request(sources), { definitionsDir: 'definitions' })
    assert.match(result.docxMarkdown, /Orders are capped\^\[Billing API, limits, src\/orders\/limits\.ts, at commit c0ffee1\] as the\^\[readme, README\.md, at commit 0ld0ld1\] says\./)
    for (const text of [result.markdown, result.docxMarkdown]) assert.equal(appendixOf(text), APPENDIX)
    // An entry with neither a filename nor a pointer is still refused.
    await assert.rejects(runLocalWorkspaceCompute('compile', request([{ id: 'billing-api', title: 'Billing API' }]), { definitionsDir: 'definitions' }), /must carry a filename/)
  })
})

// --- #360: a document a newer one replaces -------------------------------------------------------------------------
// An architect uploads an updated two pager with **This replaces…**. Fields written before still cite the old copy, so both
// stay in the Sources appendix while they are cited, and the old one says which document replaces it: the newest replacement,
// by the rule the Source documents panel uses (web/lib/sourceDocuments.js's replacedByMap). Through the real render on a
// server workspace and through a Local Workspace's compute request, which carries the replacement's title and nothing more.

describe('a document a newer one replaces (#360)', () => {
  const OLD_PAGER = { id: 'gantry-two-pager', title: 'Gantry_Two_pager', filename: 'Gantry_Two_pager.docx', uploadedBy: 'a.architect', uploadedAt: '2026-10-01T00:00:00.000Z', size: 100 }
  const NEW_PAGER = { id: 'gantry-two-pager-2', title: 'Gantry - Two pager', filename: 'Gantry - Two pager.docx', uploadedBy: 'a.architect', uploadedAt: '2026-11-02T00:00:00.000Z', size: 120, replaces: 'gantry-two-pager' }
  const rowsOf = (appendix) => appendix.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Document') && !line.startsWith('| ---')).map((line) => line.split(' | ')[0].slice(2))

  test('a cited document a newer one replaces reads "(replaced by <newer title>)", and the newer one, cited too, is its own row', () => {
    const appendix = buildSourceAppendix('[old](source:gantry-two-pager) and [new](source:gantry-two-pager-2)', [OLD_PAGER, NEW_PAGER])
    assert.deepEqual(rowsOf(appendix), ['Gantry_Two_pager (replaced by Gantry - Two pager)', 'Gantry - Two pager'])
    assert.match(appendix, /\| Gantry_Two_pager \(replaced by Gantry - Two pager\) \| Gantry_Two_pager\.docx \| 1 Oct 2026 \|/, 'the filename and date are the old copy\'s')
  })

  test('with only the old one cited there is one row, marked; with only the new one cited the old one is not listed', () => {
    assert.deepEqual(rowsOf(buildSourceAppendix('[old](source:gantry-two-pager)', [OLD_PAGER, NEW_PAGER])), ['Gantry_Two_pager (replaced by Gantry - Two pager)'])
    assert.deepEqual(rowsOf(buildSourceAppendix('[new](source:gantry-two-pager-2)', [OLD_PAGER, NEW_PAGER])), ['Gantry - Two pager'])
  })

  test('in a chain each row names its direct replacement, and of two replacements the newest is named', () => {
    const third = { id: 'two-pager-3', title: 'Two pager v3', filename: 'v3.docx', uploadedAt: '2026-11-05T00:00:00.000Z', replaces: 'gantry-two-pager-2' }
    const chain = [OLD_PAGER, NEW_PAGER, third]
    assert.deepEqual(rowsOf(buildSourceAppendix('[old](source:gantry-two-pager) [new](source:gantry-two-pager-2)', chain)), ['Gantry_Two_pager (replaced by Gantry - Two pager)', 'Gantry - Two pager (replaced by Two pager v3)'])
    const later = { id: 'two-pager-redo', title: 'Two pager, redone', filename: 'redo.docx', uploadedAt: '2026-11-08T00:00:00.000Z', replaces: 'gantry-two-pager' }
    assert.deepEqual(rowsOf(buildSourceAppendix('[old](source:gantry-two-pager)', [OLD_PAGER, later, NEW_PAGER])), ['Gantry_Two_pager (replaced by Two pager, redone)'])
  })

  test('a removed document that is also replaced reads "(replaced by …)" and not "(removed)"; one with no replacement still reads "(removed)"', () => {
    const removed = { ...OLD_PAGER, removedAt: '2026-11-03T00:00:00.000Z' }
    assert.deepEqual(rowsOf(buildSourceAppendix('[old](source:gantry-two-pager)', [removed, NEW_PAGER])), ['Gantry_Two_pager (replaced by Gantry - Two pager)'])
    assert.deepEqual(rowsOf(buildSourceAppendix('[old](source:gantry-two-pager)', [removed])), ['Gantry_Two_pager (removed)'])
  })

  test('a replacement\'s title holding a pipe cannot break the table', () => {
    const appendix = buildSourceAppendix('[old](source:gantry-two-pager)', [OLD_PAGER, { ...NEW_PAGER, title: 'Two | pager' }])
    assert.match(appendix, /\| Gantry_Two_pager \(replaced by Two \\\| pager\) \| Gantry_Two_pager\.docx \|/)
  })

  test('what a Local Workspace render sends: the cited entries only, each with what a render prints, and a replaced one with its replacement\'s title and nothing else of it', () => {
    const notCited = { id: 'never-cited', title: 'Never cited', filename: 'other.pdf', uploadedAt: '2026-01-01T00:00:00.000Z', size: 10, text: 'sources/.text/other.pdf.txt', replaces: 'gantry-two-pager-2' }
    const entries = [{ ...OLD_PAGER, text: 'sources/.text/old.txt', textChangedAt: '2026-10-02T00:00:00.000Z' }, { ...NEW_PAGER, removedAt: '2026-11-04T00:00:00.000Z', removedBy: 'a.architect' }, notCited]
    assert.deepEqual(sourceEntriesForRender('[old](source:gantry-two-pager)', entries), [
      { id: 'gantry-two-pager', filename: 'Gantry_Two_pager.docx', title: 'Gantry_Two_pager', uploadedAt: '2026-10-01T00:00:00.000Z', replacedBy: 'Gantry - Two pager' },
    ])
    // The newer one, cited too, goes as itself; it says nothing of what it replaces, only of what replaces it.
    assert.deepEqual(sourceEntriesForRender('[new](source:gantry-two-pager-2)', entries), [
      { id: 'gantry-two-pager-2', filename: 'Gantry - Two pager.docx', title: 'Gantry - Two pager', uploadedAt: '2026-11-02T00:00:00.000Z', removedAt: '2026-11-04T00:00:00.000Z', replacedBy: 'Never cited' },
    ])
    assert.deepEqual(sourceEntriesForRender('nothing cited', entries), [])
  })

  test('the render marks it, in the exported .md and in the Word text, the same on a server workspace and a Local Workspace', async () => {
    const manifest = [...MANIFEST, OLD_PAGER, NEW_PAGER]
    const citing = `${CITED} The plan is in the [two pager](source:gantry-two-pager), now the [new two pager](source:gantry-two-pager-2).`
    const APPENDIX = [
      '# Sources',
      '',
      '| Document | File | Added |',
      '| --- | --- | --- |',
      '| Client brief | Client brief v3.docx | 4 Mar 2026 |',
      '| Old notes (removed) | notes.txt | 15 Jan 2026 |',
      '| Gantry_Two_pager (replaced by Gantry - Two pager) | Gantry_Two_pager.docx | 1 Oct 2026 |',
      '| Gantry - Two pager | Gantry - Two pager.docx | 2 Nov 2026 |',
    ].join('\n')
    const appendixOf = (text) => text.slice(text.lastIndexOf('# Sources')).trim()
    await withCitingExample({ appendix: true, manifest, citing }, ({ instancesDir, definitionsDir }) => {
      for (const options of [{ wordTags: false }, {}]) {
        const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir, dryRun: true, ...options })
        for (const text of [result.markdown, result.docxMarkdown]) assert.equal(appendixOf(text), APPENDIX)
        // The footnotes are the citations' own words, as before.
        assert.match(result.docxMarkdown, /in the\^\[two pager\], now the\^\[new two pager\]\./)
      }
    })

    const instanceYaml = readFileSync(join(EXAMPLE, 'instance.yaml'), 'utf8').replace(/^definitionVersion: \d+$/m, 'definitionVersion: 3')
    const moduleFiles = {}
    for (const file of readdirSync(join(EXAMPLE, 'modules'))) {
      const text = readFileSync(join(EXAMPLE, 'modules', file), 'utf8')
      moduleFiles[file.replace(/\.md$/, '')] = file === 'background.md' ? text.replace(/\n## Affected domains/, `\n${citing}\n\n## Affected domains`) : text
    }
    const assets = readdirSync(join(EXAMPLE, 'assets')).map((file) => ({ id: file, base64: readFileSync(join(EXAMPLE, 'assets', file)).toString('base64') }))
    const request = (sources) => ({ definitionId: 'design', definitionVersion: 3, instanceYaml, moduleFiles, assets, artefact: 'soap', sources })
    // What web/app.js's buildLocalComputePayload sends.
    const sources = sourceEntriesForRender(Object.values(moduleFiles).join('\n'), manifest)
    const result = await runLocalWorkspaceCompute('compile', request(sources), { definitionsDir: 'definitions' })
    for (const text of [result.markdown, result.docxMarkdown]) assert.equal(appendixOf(text), APPENDIX)
    assert.match(result.docxMarkdown, /in the\^\[two pager\], now the\^\[new two pager\]\./)
    // Only the old one cited: one row, still marked.
    const onlyOld = sourceEntriesForRender('[two pager](source:gantry-two-pager)', manifest)
    const files = Object.fromEntries(Object.entries(moduleFiles).map(([id, text]) => [id, id === 'background' ? text.replace(/, now the \[new two pager\]\(source:gantry-two-pager-2\)/, '') : text]))
    const one = await runLocalWorkspaceCompute('compile', { ...request(onlyOld), moduleFiles: files }, { definitionsDir: 'definitions' })
    assert.match(appendixOf(one.markdown), /\| Gantry_Two_pager \(replaced by Gantry - Two pager\) \| Gantry_Two_pager\.docx \| 1 Oct 2026 \|$/)
    assert.doesNotMatch(appendixOf(one.markdown), /\| Gantry - Two pager \|/)
    // A replacement's title must be words.
    await assert.rejects(runLocalWorkspaceCompute('compile', request([{ ...sources[2], replacedBy: 7 }]), { definitionsDir: 'definitions' }), /replacedBy must be a string/)
  })

  test('the user guide\'s Sources appendix section describes the mark, and what a Local Workspace render sends of a replacement', () => {
    const guide = readFileSync('docs/user-guide/index.md', 'utf8')
    const start = guide.indexOf('#### The Sources appendix')
    const section = guide.slice(start, guide.indexOf('\n#### ', start + 5))
    assert.match(section, /"Gantry_Two_pager \(replaced by Gantry - Two pager\)"/)
    assert.match(section, /Bring up to date/)
    assert.match(section, /"\(replaced by …\)" in place of "\(removed\)"/)
    assert.match(section, /On a Local workspace, a render sends[^\n]*the newer one's title and nothing else of it/)
  })

  test('the real .docx ends with the marked row', async () => {
    const citing = `${CITED} The plan is in the [two pager](source:gantry-two-pager).`
    await withCitingExample({ appendix: true, manifest: [...MANIFEST, OLD_PAGER, NEW_PAGER], citing }, async ({ instancesDir, definitionsDir }) => {
      const result = renderArtefact(SLUG, 'soap', { instancesDir, definitionsDir })
      const { text } = await wordParts(result.docxPath)
      assert.match(text, /Gantry_Two_pager \(replaced by Gantry - Two pager\)\s*Gantry_Two_pager\.docx\s*1 Oct 2026/)
    })
  })
})
