import { readFileSync, mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs'
import { join, resolve, extname, isAbsolute } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Eta } from 'eta'
import { artefactModuleIds, loadDefinition } from './definition.js'
import {
  readInstance,
  readModule,
  azureDevOpsOutPath,
  instanceDisplayName,
  renderedArtefactBasename,
  instanceDefinitionVersion,
  AZURE_DEVOPS_WORKSPACE_ROOT,
} from './instance.js'
import { resolveAssetFileRefs, resolveRepoAssetFileRefs } from './assets.js'
import { createAzureDevOpsClient, AzureDevOpsAuthenticationError } from './azureDevOpsClient.js'
import { commitUrl } from './azureDevOpsFileUrl.js'

// autoTrim: false is deliberate — Eta's own default trimming strips the newline after every interpolation tag, which runs the next heading onto the same line as the preceding paragraph. The cost is that suppressed optional sections leave blank-line runs behind; renderArtefact collapses those afterwards instead.
//
// functionHeader (WI #273 / R2): the blank-field guard `na()` used to be copy-pasted into
// four (then six) design templates. Injecting the one definition here as a function header
// puts it in scope for every template *and* every `include()`d partial, so the definition
// lives in exactly one place. Harmless for definitions/partials that never call it.
const NA_HELPER = "const na = (v) => (typeof v === 'string' && v.trim() !== '') ? v : '— n/a —';"
const eta = new Eta({ autoTrim: false, functionHeader: NA_HELPER })

function findArtefactSpec(definition, artefactId) {
  const artefact = definition.artefacts.find((a) => a.id === artefactId)
  if (!artefact) {
    throw new Error(`Definition "${definition.id}" has no artefact "${artefactId}"`)
  }
  return artefact
}

/**
 * reviewSummary shape (single source of truth — consumed by lib/render.js's
 * pipeline-injected Document Control + Review & sign-off block, built by
 * lib/server.js's render routes from reviewStatus.js / stageReview.js /
 * stageApproval.js / work-item + PR data, and documented here for both):
 *
 * {
 *   version: string,            // e.g. "design v1 · Detailed Design"
 *   stageTitle: string,         // stage title for the artefact's own gate
 *   date: string,               // YYYY-MM-DD — same value the old footer used (commit.date)
 *   commit: { hash: string, url?: string, date?: string }, // short hash, hyperlinked for workspace-backed, plain for local
 *   gateStatus: string,         // Draft | In review | Changes requested | Approved | Passed (artefact's own gate)
 *   rows: [{ name, role, date, process, status, reference: { text, url? } }] // one per review + one per sign-off for this gate only; Pending when none
 * }
 *
 * `compileArtefact` stays pure — no network calls or
 * reviewStatus/stageReview/stageApproval imports — data arrives via
 * `options.reviewSummary`; commit hash/url/date may be merged from
 * `options.commit` / `options.azureDevOps` when the caller didn't already
 * populate them (the Azure-DevOps-backed two-push flow only knows the hash
 * after its first push).
 */

function escapePipe(value) {
  return String(value ?? '').replace(/\|/g, '\\|')
}

function buildDocumentControlMarkdown(reviewSummary, definitionDir) {
  if (!reviewSummary) return ''
  // Prefer the shared Eta partial when it exists (design definition's
  // templates/_documentControl.md.tmpl) — keeps the two-table layout in one
  // place rather than duplicated inline, satisfying the "shared partial
  // referenced by the pipeline" requirement. Fall back to inline rendering
  // for any definition that hasn't shipped the partial yet (e.g. the
  // temporary "another-definition" copies tests create) so no definition
  // loses its commit reference.
  const partialCandidates = []
  if (definitionDir) partialCandidates.push(join(definitionDir, 'templates', '_documentControl.md.tmpl'))
  partialCandidates.push('definitions/design/1/templates/_documentControl.md.tmpl')
  for (const p of partialCandidates) {
    try {
      if (existsSync(p)) {
        const src = readFileSync(p, 'utf8')
        // The partial already contains headings and the commit hyperlink logic;
        // ensure at least one Pending row when caller gave none, same as inline.
        const normalized = {
          ...reviewSummary,
          rows: reviewSummary.rows?.length
            ? reviewSummary.rows
            : [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }],
        }
        // eta autoTrim false keeps heading newlines intact
        return eta.renderString(src, normalized).replace(/\n{3,}/g, '\n\n')
      }
    } catch {
      // fall through to inline
    }
  }

  const commit = reviewSummary.commit ?? {}
  const commitCell = commit.url
    ? `[\`${commit.hash}\`](${commit.url})`
    : commit.hash
      ? `\`${commit.hash}\``
      : ''
  const version = reviewSummary.version ?? ''
  const date = reviewSummary.date ?? commit.date ?? ''
  const gateStatus = reviewSummary.gateStatus ?? 'Draft'
  const rows = reviewSummary.rows?.length
    ? reviewSummary.rows
    : [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }]

  let docControl = `## Document Control\n\n| Field | Value |\n|---|---|\n| Version | ${escapePipe(version)} |\n| Date | ${escapePipe(date)} |\n| Commit | ${commitCell} |\n| Status | ${escapePipe(gateStatus)} |\n`
  let reviewBlock = `## Review & sign-off\n\n| Name | Role / Title | Date | Review process | Status | Reference |\n|---|---|---|---|---|---|\n`
  for (const r of rows) {
    const refCell = r.reference?.url ? `[${r.reference.text}](${r.reference.url})` : (r.reference?.text ?? '')
    reviewBlock += `| ${escapePipe(r.name)} | ${escapePipe(r.role)} | ${escapePipe(r.date)} | ${escapePipe(r.process)} | ${escapePipe(r.status)} | ${escapePipe(refCell)} |\n`
  }
  return `${docControl}\n${reviewBlock}`
}

function injectDocumentControl(markdown, reviewSummary, definitionDir) {
  if (!reviewSummary) return markdown
  const block = buildDocumentControlMarkdown(reviewSummary, definitionDir)
  if (!block) return markdown
  const lines = markdown.split('\n')
  const titleIdx = lines.findIndex((l) => /^#\s+/.test(l))
  if (titleIdx !== -1) {
    const before = lines.slice(0, titleIdx + 1).join('\n')
    const after = lines.slice(titleIdx + 1).join('\n')
    return `${before}\n\n${block}\n${after}`.replace(/\n{3,}/g, '\n\n')
  }
  return `${block}\n\n${markdown}`.replace(/\n{3,}/g, '\n\n')
}

// AB#345: the zip-release pipeline (azure-pipelines.zip-release.yml, WI #312) packages a
// Git-free distributable — by design there is never a .git directory at the install dir a
// zip-release instance runs from. Its staging step stamps the source commit it packaged into
// this file at the root of the staged output, so a zip-release install can name a genuine,
// package-time commit instead of either shelling out to a `git` that can't exist there or
// falling all the way back to "unknown". A normal git-clone install never has this file, so
// it always falls through to the live `git` lookup below, unchanged.
const BUILD_INFO_FILENAME = '.build-info.json'

function buildInfoCommit(cwd) {
  const path = join(cwd ?? process.cwd(), BUILD_INFO_FILENAME)
  if (!existsSync(path)) return null
  try {
    const info = JSON.parse(readFileSync(path, 'utf8'))
    if (!info || typeof info.hash !== 'string' || !info.hash) return null
    return { hash: info.hash, date: typeof info.date === 'string' ? info.date : null }
  } catch {
    // Malformed stamp file — fall through to the live git lookup rather than fail the render over it.
    return null
  }
}

// Local-instance source of the footer's commit info (#98): the current repo's HEAD at render time, via a plain read-only `git` call — the simplest available source when there's no push response to read it from instead (see commitInfoFromPush, the Azure-DevOps-backed equivalent, below), and no `.build-info.json` stamp (above) to read it from instead. `cwd` defaults to the process's own working directory — the gantry repo itself, since local instances live inside it — but is overridable so tests can point this at a scratch repo instead of asserting against whatever commit this repo's HEAD happens to be at test-run time.
//
// A missing/uninitialised git repo must never fail a local render (AB#345 — zip-release
// installs, WI #312, never have one): `git`'s own "not a git repository" failure is caught
// specifically and turned into an "unknown" commit sentinel so the render still succeeds;
// the Document Control table then shows `unknown` in place of a hash. Any other/unexpected
// git failure (e.g. git not installed, a corrupt repo) still rethrows as one clear,
// actionable error rather than git's own raw stderr. `stdio: ['ignore', 'pipe', 'pipe']` is
// deliberate, not just `encoding` — execFileSync's default stdio *inherits* the child's
// stderr straight to this process's own, so without overriding it, git's raw error text
// would still print directly to the terminal even though the thrown JS error's own message
// is clean.
function localHeadCommitInfo({ cwd } = {}) {
  const stamped = buildInfoCommit(cwd)
  if (stamped) return stamped

  const runGit = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    return {
      hash: runGit(['rev-parse', '--short', 'HEAD']),
      date: runGit(['log', '-1', '--format=%cs']),
    }
  } catch (err) {
    const stderr = (err.stderr || err.message || '').toString()
    if (/not a git repository/i.test(stderr)) {
      return { hash: 'unknown', date: null }
    }
    throw new Error(
      `Cannot determine the local git commit for this render's Document Control (was footer) (needs a git checkout with at least one ` +
        `commit at ${cwd ?? 'the current working directory'}): ${stderr.trim()}`
    )
  }
}

// Azure-DevOps-backed source of the Document Control commit info (#98, now relocated): read straight off the push response Azure DevOps already returns when the artefact is pushed (see renderArtefactFromAzureDevOps below) — never a separate call — since that response already carries the exact commit the push just created, before this function's caller re-pushes the artefact a second time with the Document Control block naming it.
function commitInfoFromPush(push) {
  const commit = push?.commits?.[0]
  if (!commit?.commitId) {
    throw new Error('Azure DevOps push response did not include a commit — cannot build the Document Control commit info')
  }
  // Real Azure DevOps push responses always carry at least one of these (committer/author date on the commit, or the push's own date) — this is a fail-loudly guard against a malformed/unexpected response, not a path any real render is expected to hit. Reusing the commit hash as a fake "date" here would be a strictly worse failure mode: a footer that silently claims a date has no meaningful value.
  const isoDate = commit.committer?.date ?? commit.author?.date ?? push.date
  if (!isoDate) {
    throw new Error(
      `Azure DevOps push response for commit ${commit.commitId} had no committer/author/push date — cannot build the Document Control commit info`
    )
  }
  return {
    hash: commit.commitId.slice(0, 7),
    fullHash: commit.commitId,
    date: isoDate.slice(0, 10),
  }
}

// WI260 — fetch repo assets for a workspace-backed render before invoking Pandoc. Mirrors lib/server.js's asset listing but writes locally so pandoc can embed. Shared by both pushes of the two-push flow. No-op when the assets folder doesn't exist yet.
async function fetchRepoAssetsForRender(slug, azureDevOps, instancesDir) {
  const branch = azureDevOps.branch ?? 'main'
  const client = createAzureDevOpsClient(azureDevOps)
  const assetsPath = `${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/assets`
  let items = await client.listFolder(assetsPath, { branch })
  let files = items.filter((item) => !item.isFolder)
  // Also include assets that exist on main but not yet on the stage branch (branch created before asset was committed there) — prefer branch version when both exist.
  if (branch !== 'main') {
    const mainItems = await client.listFolder(assetsPath, { branch: 'main' })
    const branchPaths = new Set(files.map((f) => f.path))
    for (const item of mainItems) {
      if (!item.isFolder && !branchPaths.has(item.path)) {
        files.push({ ...item, _branch: 'main' })
      }
    }
  }
  if (files.length === 0) return
  const localAssetsDir = join(instancesDir, slug, 'assets')
  mkdirSync(localAssetsDir, { recursive: true })
  for (const item of files) {
    const filename = item.path.split('/').pop()
    const fetchBranch = item._branch ?? branch
    const content = await client.getFileContent(item.path, { branch: fetchBranch })
    const ext = extname(filename).toLowerCase()
    const isImage = ext === '.png' || ext === '.jpg' || ext === '.jpeg'
    let buffer
    const cleaned = content.replace(/\s/g, '')
    const looksBase64 = cleaned.length % 4 === 0 && cleaned.length > 0 && /^[A-Za-z0-9+/=]+$/.test(cleaned)
    if (isImage && looksBase64) {
      try {
        buffer = Buffer.from(content, 'base64')
        // Validate round-trip to avoid misclassifying short text as base64
        if (buffer.toString('base64').replace(/\s/g, '') !== cleaned) {
          buffer = Buffer.from(content, 'utf8')
        }
      } catch {
        buffer = Buffer.from(content, 'utf8')
      }
    } else {
      buffer = Buffer.from(content, 'utf8')
    }
    writeFileSync(join(localAssetsDir, filename), buffer)
  }
}

// Compiles the artefact's template against already-fetched instance/module data and (unless `dryRun`) converts the result to a .docx via pandoc. Shared by the local and Azure-DevOps-backed paths below — they differ only in *how* `instance`/`modules` were fetched, never in this part. Rendered output always lands under the local `instancesDir`/`slug`/`out` first — pandoc needs a real file on disk to write to, and for a local instance that local copy is the whole story. For an Azure-DevOps-backed instance it's a build scratch step only: `renderArtefactFromAzureDevOps` (below) pushes the resulting `.docx` on to the Azure DevOps repo afterwards, so the artefact ends up living alongside the instance data it was rendered from, not stranded on whichever machine `gantry serve` happens to be running on.
function compileArtefact(slug, artefact, instance, modules, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  // Version-aware: definition carries its own resolved directory (definitions/<id>/<n>)
  const definitionForTemplate = options.definition
  const templateBase = definitionForTemplate?.definitionDir ?? join(definitionsDir, instance.definition)
  const templatePath = join(templateBase, artefact.template)
  const templateSource = readFileSync(templatePath, 'utf8')
  // views (WI #273 / R2): scope the renderer to this definition's own directory so a
  // template can `include('templates/_partial.md.tmpl', …)` to pull in blocks shared
  // between artefacts (Introduction optional fields, recovery-plan detail, …) instead
  // of copy-pasting them. Per-render because the directory varies by definition/version.
  const templateEta = eta.withConfig({ views: resolve(templateBase) })
  const compiled = templateEta.renderString(templateSource, { instance, modules }).replace(/\n{3,}/g, '\n\n')
  // A module field's markdown may hand-type or have inserted (#80) an `asset:<id>` reference at any paragraph position — resolve it to the asset's real file in the instance's assets/ directory now, in place, so pandoc embeds the actual image at that same position rather than leaving a broken/literal "asset:<id>" link in the compiled artefact.
  let resolved = resolveAssetFileRefs(compiled, slug, { instancesDir })
  // WI260 repo-as-asset-store: for workspace-backed instances also rewrite relative `../assets/<name>` / `assets/<name>` refs to the absolute local path where fetchRepoAssetsForRender materialised the repo files, so pandoc embeds them the same way it does `asset:<id>` for local instances. Local-instance path stays byte-for-byte unchanged (guarded by options.azureDevOps).
  if (options.azureDevOps) {
    resolved = resolveRepoAssetFileRefs(resolved, slug, { instancesDir })
  }

  // --- Document Control + Review & sign-off injection (WI233) ---
  // Pipeline-injected for *every* definition, not just "design" — this is what
  // carries the commit hash/date that appendFooter() used to, so no definition
  // loses its commit reference. Driven by `options.reviewSummary` (assembled
  // by lib/server.js's render routes from reviewStatus/stageReview/stageApproval
  // + work-item/PR data); compileArtefact itself stays pure with no new network
  // calls or reviewStatus imports.
  // Fallback for callers that didn't build a reviewSummary (CLI, tests, or a
  // non-design definition): synthesize a minimal one from the commit info
  // already available so the commit hash/date still lands in the Document
  // Control table.
  let reviewSummary = options.reviewSummary ?? null
  if (!reviewSummary && options.commit) {
    const stageForArtefact = definitionForTemplate?.stages?.find((s) => s.gate === artefact.gate) ?? null
    const versionStr = `${definitionForTemplate.id} v${definitionForTemplate.version} · ${stageForArtefact ? stageForArtefact.title : artefact.title}`
    const commitUrlStr =
      options.azureDevOps && options.commit.fullHash
        ? commitUrl(options.azureDevOps, options.commit.fullHash)
        : undefined
    reviewSummary = {
      version: versionStr,
      stageTitle: stageForArtefact?.title ?? artefact.title,
      date: options.commit.date,
      commit: { hash: options.commit.hash, url: commitUrlStr, date: options.commit.date },
      gateStatus: 'Draft',
      rows: [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }],
    }
  } else if (reviewSummary && options.commit) {
    // Merge commit info from the render's own commit source (localHeadCommitInfo
    // or commitInfoFromPush) when the server-built summary didn't yet know it.
    const commitHash = options.commit.hash
    const commitUrlStr =
      options.azureDevOps && options.commit.fullHash ? commitUrl(options.azureDevOps, options.commit.fullHash) : undefined
    if (!reviewSummary.commit?.hash && commitHash) {
      reviewSummary = {
        ...reviewSummary,
        commit: { hash: commitHash, url: commitUrlStr ?? reviewSummary.commit?.url, date: options.commit.date },
      }
    } else if (commitUrlStr && !reviewSummary.commit?.url) {
      reviewSummary = { ...reviewSummary, commit: { ...reviewSummary.commit, url: commitUrlStr } }
    }
    if (!reviewSummary.date && options.commit.date) {
      reviewSummary = { ...reviewSummary, date: options.commit.date }
    }
    if (!reviewSummary.commit?.date && options.commit.date) {
      reviewSummary = { ...reviewSummary, commit: { ...reviewSummary.commit, date: options.commit.date } }
    }
  } else if (reviewSummary && !reviewSummary.rows?.length) {
    reviewSummary = {
      ...reviewSummary,
      rows: [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }],
    }
  } else if (!reviewSummary && definitionForTemplate) {
    // No commit yet (e.g. Azure-DevOps dry-run) — still inject a block so the
    // artefact never loses its commit reference site; commit cell just stays empty.
    const stageForArtefact = definitionForTemplate?.stages?.find((s) => s.gate === artefact.gate) ?? null
    const versionStr = `${definitionForTemplate.id} v${definitionForTemplate.version} · ${stageForArtefact ? stageForArtefact.title : artefact.title}`
    reviewSummary = {
      version: versionStr,
      stageTitle: stageForArtefact?.title ?? artefact.title,
      date: new Date().toISOString().slice(0, 10),
      commit: { hash: '', url: '', date: '' },
      gateStatus: 'Draft',
      rows: [{ name: '', role: '', date: '', process: '', status: 'Pending', reference: { text: '', url: '' } }],
    }
  }

  const definitionDirForPartial = definitionForTemplate?.definitionDir
  const markdown = injectDocumentControl(resolved, reviewSummary, definitionDirForPartial)

  const outDir = join(instancesDir, slug, 'out')
  // WI226: output basename is "<Instance name> - <Full artefact title>", not
  // "<artefactId>". The reference-doc lookup below stays keyed on artefact.id.
  const basename = renderedArtefactBasename(instanceDisplayName(instance), artefact.title)
  const mdPath = join(outDir, `${basename}.md`)
  const docxPath = join(outDir, `${basename}.docx`)

  // Artefact-aware reference doc resolution (WI153): the `design` definition's
  // five artefacts previously shared one `reference.docx` that was built
  // directly from the TAC HLD source template, so every artefact inherited
  // HLD's hardcoded footer "Technical Architecture Committee – High Level
  // Solution Design". Resolve by artefact first (`reference-<artefact>.docx`),
  // falling back to the definition-level `reference.docx` for definitions
  // that have not yet split their template per artefact.
  // Current footer policy per WI153 triage:
  //  - hld: keeps TAC footer (correct for that artefact)
  //  - soap / as-built: no committee-specific footer (defensible, matches
  //    domain docs — SOAP is Business Case, as-built is "for noting")
  //  - sad / ssad: placeholder (no committee text) until the ARB/TAC vs
  //    Design Authority decision is made — distinct files exist so that
  //    decision can land without further code changes.
  //
  // Resolved unconditionally (even on a dry run, WI314) — the WASM Pandoc render path
  // (web/lib/pandocWasm.js) needs to know which reference-doc file to fetch and inject
  // into its own virtual filesystem before it can convert, and dryRun is exactly the mode
  // the server-side "compile" helpers (lib/localWorkspace.js, lib/server.js's Azure-DevOps
  // wasm-prepare route) use to hand that markdown + reference-doc identity to the browser
  // without ever invoking native pandoc themselves.
  const templateBaseForRef = definitionForTemplate?.definitionDir ?? join(definitionsDir, instance.definition)
  const artefactReferenceDoc = join(templateBaseForRef, 'templates', `reference-${artefact.id}.docx`)
  const defaultReferenceDoc = join(templateBaseForRef, 'templates', 'reference.docx')
  const referenceDoc = existsSync(artefactReferenceDoc) ? artefactReferenceDoc : defaultReferenceDoc
  const referenceDocPath = existsSync(referenceDoc) ? referenceDoc : null

  // WI #359 — which output(s) a render actually persists. `'docx'` (the default, and every
  // caller that predates this option) produces only the `.docx`; `'md'` produces only the
  // `.md`. `markdown` (the compiled string) is always returned regardless, so a caller that
  // only needs the text never has to read either file back off disk. `mdPath`/`docxPath` on
  // the returned object are `null` when that format wasn't produced this render — a signal to
  // callers, not just an unwritten file — so nothing downstream can accidentally read a file
  // that (by design) was never created.
  const format = options.format === 'md' ? 'md' : 'docx'

  if (options.dryRun) {
    return { markdown, mdPath, docxPath, basename, referenceDocPath, dryRun: true, format }
  }

  // WI #360 — a server-hosted (directory-backed) instance's render is delivered straight to
  // the browser as a download instead of being persisted under the instance's own `out/`
  // directory at all. `deliverToClient` never touches `outDir` — not even to create it — and
  // for `'docx'` the final file is produced in a scratch temp location, read back into memory,
  // and removed, exactly like the existing scratch `.md` handling below does for the
  // docx-only case. Azure-DevOps-backed and local-workspace (ADR-0029) rendering never pass
  // this option and are completely unaffected.
  const deliverToClient = options.deliverToClient === true

  if (format === 'md') {
    if (deliverToClient) {
      return { markdown, mdPath: null, docxPath: null, basename, referenceDocPath, dryRun: false, format }
    }
    mkdirSync(outDir, { recursive: true })
    writeFileSync(mdPath, markdown)
    return { markdown, mdPath, docxPath: null, basename, referenceDocPath, dryRun: false, format }
  }

  // format === 'docx': pandoc needs a real `.md` file to convert from, but that file is only
  // ever an implementation detail of producing the `.docx` here — it must not land in the
  // instance's own `out/` directory (that would silently "persist" markdown a docx-only render
  // was never asked to keep). Compile it to a scratch temp file instead, convert, then remove
  // the scratch file — `outDir` never holds a `.md` for a docx-only render.
  const scratchMdPath = join(tmpdir(), `gantry-render-${randomUUID()}.md`)
  writeFileSync(scratchMdPath, markdown)
  // WI #360: when delivering to the client, the `.docx` itself is also just a scratch file —
  // never written into `outDir` — read back into memory and removed once its bytes are in hand.
  const targetDocxPath = deliverToClient ? join(tmpdir(), `gantry-render-${randomUUID()}.docx`) : docxPath
  if (!deliverToClient) {
    mkdirSync(outDir, { recursive: true })
  }
  try {
    const args = ['-f', 'markdown', '-t', 'docx']
    if (referenceDocPath) {
      args.push('--reference-doc', referenceDocPath)
    }
    // WI260: for workspace-backed, also pass --resource-path so relative image refs that weren't rewritten (or bonus asset:<id> resolved against repo) still resolve against the materialised assets dir. Local path unchanged.
    if (options.azureDevOps) {
      const assetsDir = join(instancesDir, slug, 'assets')
      if (existsSync(assetsDir)) {
        args.push('--resource-path', resolve(assetsDir))
      }
    }
    args.push('-o', targetDocxPath, scratchMdPath)
    execFileSync('pandoc', args)
    if (deliverToClient) {
      const docxBytes = readFileSync(targetDocxPath)
      return { markdown, mdPath: null, docxPath: null, docxBytes, basename, referenceDocPath, dryRun: false, format }
    }
  } finally {
    rmSync(scratchMdPath, { force: true })
    if (deliverToClient) rmSync(targetDocxPath, { force: true })
  }

  return { markdown, mdPath: null, docxPath, basename, referenceDocPath, dryRun: false, format }
}

// WI #367 — the browser-side (pandoc-wasm) render leg's counterpart to the `--resource-path` the
// native leg gives the `pandoc` subprocess.
//
// `resolveAssetFileRefs`/`resolveRepoAssetFileRefs` rewrite every `asset:<id>` and `assets/<name>`
// reference to an **absolute path on the machine running `gantry serve`**, which is exactly what the
// native leg needs and exactly what the WASM leg cannot use: pandoc-wasm runs in the browser against
// a virtual filesystem, so an absolute server path resolves to nothing and Pandoc drops the image
// silently — no warning, no error, just a .docx with the picture missing. Mermaid diagrams survived
// only because web/lib/mermaid.js renders those in the browser and hands Pandoc the PNG bytes
// directly; nothing was doing the same for an author's own uploaded images.
//
// This reads each referenced file server-side and rewrites the reference to a bare virtual filename,
// so the prepare route can ship the bytes alongside the markdown and the browser can put them in
// Pandoc's virtual filesystem under exactly those names. A reference that doesn't resolve to a real
// file on disk is left untouched — it was already not going to embed, and mangling it here would
// only make the eventual output harder to explain.
//
// @returns {{ markdown: string, files: Record<string, string> }} rewritten markdown, and the
//   referenced files' bytes as base64 keyed by the virtual filename the markdown now points at.
export function externaliseImagesForWasm(markdown) {
  const files = {}
  const virtualNameByPath = new Map()
  const rewritten = (markdown ?? '').replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, rawTarget) => {
    const target = rawTarget.trim().replace(/^<(.*)>$/, '$1')
    if (!isAbsolute(target)) return match
    let bytes
    try {
      if (!statSync(target).isFile()) return match
      bytes = readFileSync(target)
    } catch {
      return match
    }
    // One virtual name per distinct source path — the same image referenced twice is shipped once.
    let name = virtualNameByPath.get(target)
    if (!name) {
      name = `gantry-asset-${virtualNameByPath.size + 1}${extname(target).toLowerCase()}`
      virtualNameByPath.set(target, name)
      files[name] = bytes.toString('base64')
    }
    return `![${alt}](${name})`
  })
  return { markdown: rewritten, files }
}

/**
 * `gantry render <slug> <artefactId>`: compiles the artefact's template against the instance's required module data, then (unless `dryRun`) converts the resulting Markdown to a .docx via pandoc.
 *
 * With `options.azureDevOps` supplied, reads the instance/module data from that Azure DevOps repo instead of the local filesystem (see renderArtefactFromAzureDevOps below) and returns a Promise the caller must `await`. Without it — every existing caller — this stays exactly the synchronous local-filesystem read it always was.
 */
export function renderArtefact(slug, artefactId, options = {}) {
  if (options.azureDevOps) {
    return renderArtefactFromAzureDevOps(slug, artefactId, options)
  }

  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const instance = readInstance(slug, { instancesDir })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    modules[moduleId] = readModule(definition, slug, moduleId, { instancesDir }).fields
  }

  // #98: sourced via a plain `git` call against this repo's own current HEAD — never a network call — since a local instance's render never pushes anything the footer could otherwise be sourced from.
  const commit = options.commit ?? localHeadCommitInfo({ cwd: options.repoDir })
  return compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition })
}

// The Azure-DevOps-backed half of renderArtefact (#86) — the exact same template compile/pandoc step as the local path (compileArtefact above), over instance/module data read from Azure DevOps instead of disk. Unlike the local path, the rendered `.docx` doesn't stop at the local scratch copy: it's pushed on to the same Azure DevOps repo the instance itself lives in, at `gantry-workspace/<slug>/out/<artefactId>.docx` (#100) on `options.azureDevOps.branch` (falling through to the client's own `'main'` default when omitted — #118), overwriting any previous render of that artefact on that same branch (the repo's own history is the audit trail — no reason to also keep every past render as a distinct file). A dry run never reaches this — `compileArtefact` returns before writing anything, local or remote.
//
// The footer's commit hash/date (#98) can only be known once Azure DevOps has actually assigned them — neither is predictable client-side before a push completes — so getting an accurate, self-consistent footer into the pushed artefact itself takes two pushes: an initial, footer-less push (identical to this function's pre-#98 behaviour) purely to learn its own resulting commit from the response Azure DevOps already returns (never a separate call/round-trip to look that commit back up some other way), followed by a second push of the same path that overwrites it with the footer naming that commit. The instance/module data itself is only read once — both pushes recompile the one already-fetched `instance`/`modules` data, not two separate reads.
//
// Known, accepted limitation: a commit can never truthfully name its own hash inside its own content (the hash is computed from the content), so the footer names the *first* (content-establishing) push's commit, not the file's own literal newest commit in the repo's history — that's always the second (footer-only) push, one commit later. Anyone reading this file's blame/history in Azure DevOps will see that second commit as the most recent touch to the path. This is also not atomic: if the second push fails after the first succeeds, the repo is left holding the first push's footer-less content with no automatic rollback (see the catch below) — a subsequent successful render corrects it, but nothing does so automatically.

/**
 * Renders every artefact belonging to `stage`'s own gate against an Azure-DevOps-backed instance, committing each rendered .docx to `options.azureDevOps.branch` — the render-on-save half of ADR-0014's "gantry renders the artefact and commits it to the branch automatically on every save throughout the stage, so the PR's diff always includes both the module files and the actual generated document, not just markdown." Saves no longer call this (WI #376, ADR-0034: documents render only when the author clicks Render); lib/stageApproval.js still does, passing its own already-resolved `options.azureDevOps.branch` — never a fresh branch resolution of its own. An artefact whose template doesn't exist yet is skipped up front, the same filter `buildInstanceResponse` (lib/server.js) already applies when deciding which artefacts to *offer* for manual rendering.
 *
 * Never throws for a rendering-specific problem: a module save that already landed must not be reported as failed just because rendering one of its stage's artefacts ran into trouble afterwards. Two distinct non-error outcomes are reported per artefact instead of one another:
 * - `{ artefactId, rendered: false, skipped: true, reason }` — the artefact's own `requires` list names a module that hasn't been saved even once yet (`readModule`'s "no saved data" case). Entirely normal early in a stage — not every module needs to exist before the first save — so this is not a failure, just "nothing to render yet."
 * - `{ artefactId, rendered: false, error }` — a genuine problem (a real Azure DevOps failure, a missing/broken `pandoc`, etc.). Reported so a caller can surface it, but still doesn't stop the loop over the stage's other artefacts, or the module save this followed.
 *
 * `AzureDevOpsAuthenticationError` is the one exception to "never throws": it propagates immediately, exactly like every other Azure-DevOps-backed aggregation in this codebase (e.g. lib/status.js's `evaluateStageFromAzureDevOps`), so the server's credential-gating layer (`withAzureDevOpsCredential`) can still turn a rejected PAT into the structured "authentication required" response instead of it being silently folded into a 200 as a per-artefact error string.
 *
 * A successful render reports `{ artefactId, rendered: true, azureDevOpsPath, commit }`, mirroring `renderArtefactFromAzureDevOps`'s own successful return shape.
 */
export async function renderStageArtefacts(slug, definition, stage, options = {}) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const templateBase = definition.definitionDir ?? join(definitionsDir, definition.id)
  const artefacts = definition.artefacts
    .filter((a) => a.gate === stage.gate)
    .filter((a) => existsSync(join(templateBase, a.template)))

  const results = []
  for (const artefact of artefacts) {
    try {
      const result = await renderArtefact(slug, artefact.id, options)
      results.push({ artefactId: artefact.id, rendered: true, azureDevOpsPath: result.azureDevOpsPath, commit: result.commit })
    } catch (err) {
      if (err instanceof AzureDevOpsAuthenticationError) throw err
      if (/has no saved data/.test(err.message)) {
        results.push({ artefactId: artefact.id, rendered: false, skipped: true, reason: err.message })
        continue
      }
      results.push({ artefactId: artefact.id, rendered: false, error: err.message })
    }
  }
  return results
}

// Shared setup for every Azure-DevOps-backed render below (native two-push, and the WI314
// WASM-prepare half): resolves the instance/definition/artefact/module data and materialises
// repo assets, all read-only work with no push of its own. Factored out so the WASM prepare
// path (below) doesn't have to duplicate — and risk drifting from — this exact sequence.
async function bootstrapAzureDevOpsRender(slug, artefactId, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const instance = await readInstance(slug, { azureDevOps: options.azureDevOps })
  const definition = loadDefinition(instance.definition, { definitionsDir, version: instanceDefinitionVersion(instance) })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    modules[moduleId] = (await readModule(definition, slug, moduleId, { azureDevOps: options.azureDevOps })).fields
  }

  // WI260: materialise repo assets before any compile so rewriting and --resource-path can resolve them; also before the second (Document Control) compile which reuses the same dir.
  await fetchRepoAssetsForRender(slug, options.azureDevOps, instancesDir)

  return { instance, definition, artefact, modules }
}

// Shared by both `renderArtefactFromAzureDevOps` and the WI314 `prepareAzureDevOpsWasmRender`
// below: pushes a footer-less draft `.docx` (native pandoc's own first-pass compile, in both
// callers) so Azure DevOps assigns it a commit, then parses that commit's hash/date out of the
// push response (`commitInfoFromPush`) — the only way to learn a commit that can then, itself,
// be truthfully named inside a *second* push's content (#98's constraint: a commit can't name
// its own hash). Factored out so the two callers' identical "the content push already landed;
// here's what's actually live" partial-failure framing can't drift between them.
async function pushDraftAndLearnCommit(client, azureDevOpsPath, artefactId, draftDocxPath, branch) {
  const draftBytes = readFileSync(draftDocxPath)
  const { push } = await client.writeFile(azureDevOpsPath, draftBytes.toString('base64'), {
    contentType: 'base64encoded',
    message: `Render ${artefactId}`,
    branch,
  })
  try {
    return commitInfoFromPush(push)
  } catch (err) {
    const rawCommitId = push?.commits?.[0]?.commitId
    throw new Error(
      `Rendered ${artefactId} and pushed it to Azure DevOps` +
        (rawCommitId ? ` as commit ${rawCommitId}` : '') +
        `, but its response couldn't be used to build the commit-hash/date Document Control: ${err.message}. ` +
        `${azureDevOpsPath} in Azure DevOps still has that Document-Control-less content — re-render to add the Document Control.`
    )
  }
}

async function renderArtefactFromAzureDevOps(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapAzureDevOpsRender(slug, artefactId, options)

  const draft = await compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draft.dryRun) return draft

  // WI #359 — the two-push commit-learning trick (see this function's own doc comment above)
  // is format-agnostic: it just needs *some* file's bytes to push, learn a commit from, then
  // push again with that commit named in its content. Works identically whether that file is
  // the `.docx` (the default) or the `.md` (format: 'md') — only the extension and which of
  // `draft.docxPath`/`draft.mdPath` is non-null changes.
  const extension = draft.format === 'md' ? 'md' : 'docx'
  const draftFilePath = draft.format === 'md' ? draft.mdPath : draft.docxPath
  const azureDevOpsPath = azureDevOpsOutPath(slug, instanceDisplayName(instance), artefact.title, extension)
  const client = createAzureDevOpsClient(options.azureDevOps)
  const branch = options.azureDevOps.branch

  const commit = await pushDraftAndLearnCommit(client, azureDevOpsPath, artefact.id, draftFilePath, branch)

  const result = await compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition })
  const finalBytes = readFileSync(result.format === 'md' ? result.mdPath : result.docxPath)
  try {
    await client.writeFile(azureDevOpsPath, finalBytes.toString('base64'), {
      contentType: 'base64encoded',
      message: `Render ${artefact.id} (commit-hash/date Document Control: ${commit.hash})`,
      branch,
    })
  } catch (err) {
    // The first push already succeeded and is live in Azure DevOps at this point — this failure only affects adding the Document Control, not whether a render happened at all. Surfaced distinctly so a caller (and whoever reads the error) knows the repo is left holding Document-Control-less content at commit ${commit.hash} rather than assuming the render itself failed outright.
    throw new Error(
      `Rendered ${artefact.id} and pushed it to Azure DevOps as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${azureDevOpsPath} in Azure DevOps still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }

  return { ...result, azureDevOpsPath, commit }
}

/**
 * WI314 — the Azure-DevOps-hosted half of the client-side WASM Pandoc render path, split
 * across two server round-trips so the browser (not this process) does the actual
 * markdown→docx conversion for the artefact anyone will ever open:
 *
 *  1. `prepareAzureDevOpsWasmRender` (this function) — identical to
 *     `renderArtefactFromAzureDevOps`'s own first push (still native `pandoc`, still
 *     footer-less): that pass is never seen by a user, immediately overwritten by the
 *     second push below, so its only job is learning the commit Azure DevOps assigns
 *     (#98's constraint: a commit can't truthfully name its own hash inside its own
 *     content). Keeping *that* one pass native — rather than round-tripping the browser a
 *     third time for content nobody reads — avoids doubling every WASM render's client-side
 *     conversion count for zero user-visible benefit. It then compiles (dry run, no pandoc)
 *     the *real* artefact — the one with an accurate Document Control commit cell — and
 *     hands its markdown plus the reference-doc bytes back to the caller (lib/server.js's
 *     route) to relay to the browser for conversion.
 *  2. `finishAzureDevOpsWasmRender` (below) — takes the browser's own WASM-converted bytes
 *     for that second compile and pushes them, exactly where the native path's own second
 *     push would have landed them.
 *
 * Never called for the `'native'` engine selection — that keeps calling
 * `renderArtefactFromAzureDevOps` exactly as before, both passes server-side, unconditionally.
 */
export async function prepareAzureDevOpsWasmRender(slug, artefactId, options) {
  const { instance, definition, artefact, modules } = await bootstrapAzureDevOpsRender(slug, artefactId, options)

  const draftPass1 = compileArtefact(slug, artefact, instance, modules, { ...options, definition })
  if (draftPass1.dryRun) return draftPass1

  const azureDevOpsPath = azureDevOpsOutPath(slug, instanceDisplayName(instance), artefact.title)
  const client = createAzureDevOpsClient(options.azureDevOps)
  const branch = options.azureDevOps.branch

  const commit = await pushDraftAndLearnCommit(client, azureDevOpsPath, artefact.id, draftPass1.docxPath, branch)

  // Pass 2, dry run: the markdown the browser's own pandoc-wasm module converts into the
  // artefact's real, final bytes — identical to what the native path's own second
  // `compileArtefact` call produces, just without invoking `pandoc` in this process.
  const draftPass2 = compileArtefact(slug, artefact, instance, modules, { ...options, commit, definition, dryRun: true })

  return { ...draftPass2, commit, azureDevOpsPath, branch }
}

/**
 * The second half of the WI314 Azure-DevOps WASM render path: pushes the browser's own
 * WASM-converted bytes for `prepareAzureDevOpsWasmRender`'s pass-2 markdown, exactly where
 * `renderArtefactFromAzureDevOps`'s own second (Document-Control) push would land them —
 * same path, same branch, same commit-naming push message.
 *
 * `docxBytes` is a `Buffer`/`Uint8Array` — the caller (lib/server.js's route) is expected to
 * have already decoded it from whatever wire format (base64) the browser sent.
 */
export async function finishAzureDevOpsWasmRender(docxBytes, { azureDevOps, azureDevOpsPath, branch, commit, artefactId }) {
  const client = createAzureDevOpsClient(azureDevOps)
  try {
    await client.writeFile(azureDevOpsPath, Buffer.from(docxBytes).toString('base64'), {
      contentType: 'base64encoded',
      message: `Render ${artefactId} (commit-hash/date Document Control: ${commit.hash})`,
      branch,
    })
  } catch (err) {
    throw new Error(
      `Rendered ${artefactId} and pushed it to Azure DevOps as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date Document Control failed: ${err.message}. ${azureDevOpsPath} in Azure DevOps still ` +
        `has the Document-Control-less content from commit ${commit.hash} — re-render to add the Document Control.`
    )
  }
  return { azureDevOpsPath }
}
