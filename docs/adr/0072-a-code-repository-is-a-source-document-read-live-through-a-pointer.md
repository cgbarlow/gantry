# A code repository is a Source document read live through a pointer

Ticket #319. Builds on ADR-0071 (Source documents from a web address), the
Source document decisions from #245, #292 (the AI reads large packs through a
catalogue), #297 (Out of date) and ADR-0067 (outside agents held to the in-app
rules). Grilled with the product owner on 2026-11-03.

For a design or As-built document the strongest evidence is often the code
itself: an existing system's services, its infrastructure, its README. Zipping
and uploading a repository loses which commit it came from and goes stale at
once.

**A pointer, not a copy.** A repository is added as a Source document that
points at a Provider repository and branch: GitHub, Azure DevOps, GitLab or
Bitbucket, on any workspace that has Source documents. Nothing from the
repository is copied into the Instance. This is the deliberate opposite of
ADR-0071's snapshot rule for web pages. A repository is already versioned
somewhere the architect controls, so a copy would add size and a second truth
without adding certainty. The architect may narrow a pointer to some folders.
Vendored code, build output and binaries are always skipped.

**It is still a Source document.** It shares the list, the panel, the manifest,
the id and the citation form with uploaded and fetched documents, and it can be
renamed and removed like them. Where a kept file would be downloaded, a pointer
opens the repository at its branch on the Provider, and **Download all** adds a
short text file listing each repository's address, branch and the commits
cited, never the code. The Sources appendix prints the title, address, branch
and the commits cited.

**The branch moves; each read records its commit.** The pointer follows a
branch, so the AI always sees current code. Every read records the commit it
saw, and a citation names that commit, so "which code did this come from?"
always has an answer. When a Stage opens, Gantry compares the files a Field
drew on at their recorded commit with the branch head. Only a real change to
one of those files flags the Field Out of date. A new commit that touches
nothing the Field used flags nothing.

**The AI reads it with tools, not a pasted copy.** The AI gets read-only tools
to list folders, search and read files at the branch. As with #292's catalogue
for large packs, nothing from the repository is put into the prompt up front.

**Whose token.** In the editor, a private repository is read with the
architect's own Provider token, held and sent as it is when connecting a
workspace. Gantry can read only what that person can read, and someone without
access gets a message saying so, not an error. An outside agent over MCP adds
and reads pointers under the same rules, using the Provider credential its MCP
server already holds for that workspace. A server-held token, like the Library
repos' one, was rejected: it would let anyone using Gantry read whatever that
token can reach.

**Provider rules, not web-page rules.** Any Provider address Gantry accepts
for a workspace, a self-hosted one on a private address included, is
acceptable for a pointer. ADR-0071's private-address check and its operator
off switch are about fetching arbitrary web pages. They do not apply here, and
there is no separate off switch.

**Built after #318.** The two share the panel and the manifest, and #319 is
built on top of #318.

## Considered options

- **A snapshot, like web pages:** repeatable, but it duplicates a versioned
  repository, needs size limits that code bases outgrow, and goes stale.
- **One Source document per file:** precise citations, but a repository would
  flood the list with hundreds of entries.
- **A fixed commit:** repeatable reads, but the AI would work from old code
  until someone moved the pointer on.
