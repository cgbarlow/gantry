# Documents render on demand, not on every save

WI #376. ADR-0014 said Gantry "renders the artefact and commits it to the
branch automatically on every save throughout the stage". In practice every
module save on a Workspace-backed instance became one commit for the module
plus two more per artefact: a draft push to learn the commit, then a second
push naming that commit in the Document Control block (#98). A commit can never
name its own hash, so a rendered document can never share a commit with the
module files it was rendered from. Pairing that with a single stage-wide Save
would still have meant several commits per click.

We stopped rendering on save. A Save writes the changed module files as one
commit on the stage branch and nothing else; documents are rendered, and
committed, only when the author clicks **Render**. The unsaved-changes prompt
runs before Render, Advance and sign-off, so a render never misses the
author's latest edits.

The cost, accepted knowingly: between renders the stage branch's documents can
lag behind its module files, so a Pull Request diff may show markdown changes
whose `.docx` hasn't been regenerated yet. The author renders before
requesting sign-off, as they already had to for anything they wanted to look
at. ADR-0014 stays in force apart from its render-on-save sentence.
