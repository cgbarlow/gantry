import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// #310: the bundled `kiwi-cover-mutual` example now cites its Source documents, so it ends every document with a Sources list and prints "(Client brief, p. 1)" in Word where the .md keeps a link.
// A test of how an Artefact that cites nothing renders (the Sources list, a Word conversion that must equal the .md as compiled) works on a copy with the citations taken out: each keeps its words and loses its address.

/** `markdown` with every `[text](source:id)` citation turned into its text. */
export const withoutCitations = (markdown) => markdown.replace(/(?<!!)\[((?:[^\]\\\n]|\\.)*)\]\(source:[A-Za-z0-9][A-Za-z0-9_-]*\)/g, '$1')

/** `markdown` with every citation taken out whole, and the space before it, so none of a document's name is left behind. */
export const withoutCitationsAtAll = (markdown) => markdown.replace(/ ?(?<!!)\[(?:[^\]\\\n]|\\.)*\]\(source:[A-Za-z0-9][A-Za-z0-9_-]*\)/g, '')

/** Takes the citations out of every Module of the Instance folder `instanceDir`, in place. */
export function removeCitations(instanceDir) {
  const dir = join(instanceDir, 'modules')
  for (const name of readdirSync(dir)) {
    const text = readFileSync(join(dir, name), 'utf8')
    const plain = withoutCitations(text)
    if (plain !== text) writeFileSync(join(dir, name), plain)
  }
}
