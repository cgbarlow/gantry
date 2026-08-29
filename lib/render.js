import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { Eta } from 'eta'
import { artefactModuleIds, loadDefinition } from './definition.js'
import {
  readInstance,
  readModule,
  azureDevOpsOutPath,
  instanceDisplayName,
  renderedArtefactBasename,
} from './instance.js'
import { resolveAssetFileRefs } from './assets.js'
import { createAzureDevOpsClient, AzureDevOpsAuthenticationError } from './azureDevOpsClient.js'
import { commitUrl } from './azureDevOpsFileUrl.js'

// autoTrim: false is deliberate — Eta's own default trimming strips the newline after every interpolation tag, which runs the next heading onto the same line as the preceding paragraph. The cost is that suppressed optional sections leave blank-line runs behind; renderArtefact collapses those afterwards instead.
const eta = new Eta({ autoTrim: false })

function findArtefactSpec(definition, artefactId) {
  const artefact = definition.artefacts.find((a) => a.id === artefactId)
  if (!artefact) {
    throw new Error(`Definition "${definition.id}" has no artefact "${artefactId}"`)
  }
  return artefact
}

// The traceability footer (#98) every rendered artefact — across every definition, not just "design" — gets appended to its compiled markdown (and, via pandoc, its .docx) before being written/pushed anywhere: a plain paragraph (never a heading, so it doesn't show up in a docx's table of contents) naming the short commit hash and date the render's source data came from. `commit` is `{ hash, date }` for local instances and additionally carries `fullHash` for Azure-DevOps-backed instances — see `localHeadCommitInfo` and `commitInfoFromPush` below for where those values come from.
function appendFooter(markdown, commit, azureDevOps) {
  if (!commit) return markdown
  const body = markdown.replace(/\n+$/, '')
  // Plain text wrapping the commit hash in an inline code span, deliberately not *also* wrapped in emphasis — pandoc's docx round-trip splits an emphasis run around a nested inline-code span into separate runs ("*text* `code` *text*"), which would make a simple substring/regex match against the round-tripped text needlessly fragile.
  const hash = azureDevOps && commit.fullHash ? `[\`${commit.hash}\`](${commitUrl(azureDevOps, commit.fullHash)})` : `\`${commit.hash}\``
  return `${body}\n\n---\n\nRendered from commit ${hash} (${commit.date}).\n`
}

// Local-instance source of the footer's commit info (#98): the current repo's HEAD at render time, via a plain read-only `git` call — the simplest available source when there's no push response to read it from instead (see commitInfoFromPush, the Azure-DevOps-backed equivalent, below). `cwd` defaults to the process's own working directory — the gantry repo itself, since local instances live inside it — but is overridable so tests can point this at a scratch repo instead of asserting against whatever commit this repo's HEAD happens to be at test-run time.
//
// Rendering a local instance never depended on `git` being installed or on `cwd` being inside a working tree before this footer existed — a missing/uninitialised repo now turns every local render into a hard failure. Rather than let that surface as `git`'s own raw stderr (e.g. "fatal: not a git repository"), it's caught and re-thrown as one clear, actionable error naming what's actually missing. `stdio: ['ignore', 'pipe', 'pipe']` is deliberate, not just `encoding` — execFileSync's default stdio *inherits* the child's stderr straight to this process's own, so without overriding it, git's raw error text would still print directly to the terminal even though the thrown JS error's own message is clean.
function localHeadCommitInfo({ cwd } = {}) {
  const runGit = (args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    return {
      hash: runGit(['rev-parse', '--short', 'HEAD']),
      date: runGit(['log', '-1', '--format=%cs']),
    }
  } catch (err) {
    throw new Error(
      `Cannot determine the local git commit for this render's footer (needs a git checkout with at least one ` +
        `commit at ${cwd ?? 'the current working directory'}): ${(err.stderr || err.message).toString().trim()}`
    )
  }
}

// Azure-DevOps-backed source of the footer's commit info (#98): read straight off the push response Azure DevOps already returns when the artefact is pushed (see renderArtefactFromAzureDevOps below) — never a separate call — since that response already carries the exact commit the push just created, before this function's caller re-pushes the artefact a second time with the footer naming it.
function commitInfoFromPush(push) {
  const commit = push?.commits?.[0]
  if (!commit?.commitId) {
    throw new Error('Azure DevOps push response did not include a commit — cannot build the render footer')
  }
  // Real Azure DevOps push responses always carry at least one of these (committer/author date on the commit, or the push's own date) — this is a fail-loudly guard against a malformed/unexpected response, not a path any real render is expected to hit. Reusing the commit hash as a fake "date" here would be a strictly worse failure mode: a footer that silently claims a date has no meaningful value.
  const isoDate = commit.committer?.date ?? commit.author?.date ?? push.date
  if (!isoDate) {
    throw new Error(
      `Azure DevOps push response for commit ${commit.commitId} had no committer/author/push date — cannot build the render footer`
    )
  }
  return {
    hash: commit.commitId.slice(0, 7),
    fullHash: commit.commitId,
    date: isoDate.slice(0, 10),
  }
}

// Compiles the artefact's template against already-fetched instance/module data and (unless `dryRun`) converts the result to a .docx via pandoc. Shared by the local and Azure-DevOps-backed paths below — they differ only in *how* `instance`/`modules` were fetched, never in this part. Rendered output always lands under the local `instancesDir`/`slug`/`out` first — pandoc needs a real file on disk to write to, and for a local instance that local copy is the whole story. For an Azure-DevOps-backed instance it's a build scratch step only: `renderArtefactFromAzureDevOps` (below) pushes the resulting `.docx` on to the Azure DevOps repo afterwards, so the artefact ends up living alongside the instance data it was rendered from, not stranded on whichever machine `gantry serve` happens to be running on.
function compileArtefact(slug, artefact, instance, modules, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'
  const instancesDir = options.instancesDir ?? 'instances'

  const templatePath = join(definitionsDir, instance.definition, artefact.template)
  const templateSource = readFileSync(templatePath, 'utf8')
  const compiled = eta.renderString(templateSource, { instance, modules }).replace(/\n{3,}/g, '\n\n')
  // A module field's markdown may hand-type or have inserted (#80) an `asset:<id>` reference at any paragraph position — resolve it to the asset's real file in the instance's assets/ directory now, in place, so pandoc embeds the actual image at that same position rather than leaving a broken/literal "asset:<id>" link in the compiled artefact.
  const resolved = resolveAssetFileRefs(compiled, slug, { instancesDir })
  // options.commit (#98) is only absent while the Azure-DevOps-backed path (below) is still on its first, footer-less compile/push — the one it uses solely to learn its own push's resulting commit — so appendFooter is a no-op there rather than an error.
  const markdown = appendFooter(resolved, options.commit, options.azureDevOps)

  const outDir = join(instancesDir, slug, 'out')
  // WI226: output basename is "<Instance name> - <Full artefact title>", not
  // "<artefactId>". The reference-doc lookup below stays keyed on artefact.id.
  const basename = renderedArtefactBasename(instanceDisplayName(instance), artefact.title)
  const mdPath = join(outDir, `${basename}.md`)
  const docxPath = join(outDir, `${basename}.docx`)

  if (options.dryRun) {
    return { markdown, mdPath, docxPath, basename, dryRun: true }
  }

  mkdirSync(outDir, { recursive: true })
  writeFileSync(mdPath, markdown)

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
  const artefactReferenceDoc = join(definitionsDir, instance.definition, 'templates', `reference-${artefact.id}.docx`)
  const defaultReferenceDoc = join(definitionsDir, instance.definition, 'templates', 'reference.docx')
  const referenceDoc = existsSync(artefactReferenceDoc) ? artefactReferenceDoc : defaultReferenceDoc
  const args = ['-f', 'markdown', '-t', 'docx']
  if (existsSync(referenceDoc)) {
    args.push('--reference-doc', referenceDoc)
  }
  args.push('-o', docxPath, mdPath)
  execFileSync('pandoc', args)

  return { markdown, mdPath, docxPath, basename, dryRun: false }
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
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    modules[moduleId] = readModule(definition, slug, moduleId, { instancesDir }).fields
  }

  // #98: sourced via a plain `git` call against this repo's own current HEAD — never a network call — since a local instance's render never pushes anything the footer could otherwise be sourced from.
  const commit = options.commit ?? localHeadCommitInfo({ cwd: options.repoDir })
  return compileArtefact(slug, artefact, instance, modules, { ...options, commit })
}

// The Azure-DevOps-backed half of renderArtefact (#86) — the exact same template compile/pandoc step as the local path (compileArtefact above), over instance/module data read from Azure DevOps instead of disk. Unlike the local path, the rendered `.docx` doesn't stop at the local scratch copy: it's pushed on to the same Azure DevOps repo the instance itself lives in, at `gantry-workspace/<slug>/out/<artefactId>.docx` (#100) on `options.azureDevOps.branch` (falling through to the client's own `'main'` default when omitted — #118), overwriting any previous render of that artefact on that same branch (the repo's own history is the audit trail — no reason to also keep every past render as a distinct file). A dry run never reaches this — `compileArtefact` returns before writing anything, local or remote.
//
// The footer's commit hash/date (#98) can only be known once Azure DevOps has actually assigned them — neither is predictable client-side before a push completes — so getting an accurate, self-consistent footer into the pushed artefact itself takes two pushes: an initial, footer-less push (identical to this function's pre-#98 behaviour) purely to learn its own resulting commit from the response Azure DevOps already returns (never a separate call/round-trip to look that commit back up some other way), followed by a second push of the same path that overwrites it with the footer naming that commit. The instance/module data itself is only read once — both pushes recompile the one already-fetched `instance`/`modules` data, not two separate reads.
//
// Known, accepted limitation: a commit can never truthfully name its own hash inside its own content (the hash is computed from the content), so the footer names the *first* (content-establishing) push's commit, not the file's own literal newest commit in the repo's history — that's always the second (footer-only) push, one commit later. Anyone reading this file's blame/history in Azure DevOps will see that second commit as the most recent touch to the path. This is also not atomic: if the second push fails after the first succeeds, the repo is left holding the first push's footer-less content with no automatic rollback (see the catch below) — a subsequent successful render corrects it, but nothing does so automatically.

/**
 * Renders every artefact belonging to `stage`'s own gate against an Azure-DevOps-backed instance, committing each rendered .docx to `options.azureDevOps.branch` — the render-on-save half of ADR-0014's "gantry renders the artefact and commits it to the branch automatically on every save throughout the stage, so the PR's diff always includes both the module files and the actual generated document, not just markdown." Intended to be called right after a module save succeeds (see `PUT /api/instance/modules/:id` in lib/server.js), using that same call's already-resolved `options.azureDevOps.branch` — never a fresh branch resolution of its own. An artefact whose template doesn't exist yet is skipped up front, the same filter `buildInstanceResponse` (lib/server.js) already applies when deciding which artefacts to *offer* for manual rendering.
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

  const artefacts = definition.artefacts
    .filter((a) => a.gate === stage.gate)
    .filter((a) => existsSync(join(definitionsDir, definition.id, a.template)))

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

async function renderArtefactFromAzureDevOps(slug, artefactId, options) {
  const definitionsDir = options.definitionsDir ?? 'definitions'

  const instance = await readInstance(slug, { azureDevOps: options.azureDevOps })
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const artefact = findArtefactSpec(definition, artefactId)

  const modules = {}
  for (const moduleId of artefactModuleIds(artefact)) {
    modules[moduleId] = (await readModule(definition, slug, moduleId, { azureDevOps: options.azureDevOps })).fields
  }

  const draft = await compileArtefact(slug, artefact, instance, modules, options)
  if (draft.dryRun) return draft

  const azureDevOpsPath = azureDevOpsOutPath(slug, instanceDisplayName(instance), artefact.title)
  const client = createAzureDevOpsClient(options.azureDevOps)
  const branch = options.azureDevOps.branch

  const draftBytes = readFileSync(draft.docxPath)
  const { push } = await client.writeFile(azureDevOpsPath, draftBytes.toString('base64'), {
    contentType: 'base64encoded',
    message: `Render ${artefact.id}`,
    branch,
  })
  let commit
  try {
    commit = commitInfoFromPush(push)
  } catch (err) {
    // The first (content) push has already landed at this point — this is the same "footer-less content is now live" partial-failure shape as the second push's own catch below, just triggered by a malformed response instead of a failed request, so it gets the same "here's what's actually there" framing rather than a bare parsing error.
    const rawCommitId = push?.commits?.[0]?.commitId
    throw new Error(
      `Rendered ${artefact.id} and pushed it to Azure DevOps` +
        (rawCommitId ? ` as commit ${rawCommitId}` : '') +
        `, but its response couldn't be used to build the commit-hash/date footer: ${err.message}. ` +
        `${azureDevOpsPath} in Azure DevOps still has that footer-less content — re-render to add the footer.`
    )
  }

  const result = await compileArtefact(slug, artefact, instance, modules, { ...options, commit })
  const finalBytes = readFileSync(result.docxPath)
  try {
    await client.writeFile(azureDevOpsPath, finalBytes.toString('base64'), {
      contentType: 'base64encoded',
      message: `Render ${artefact.id} (commit-hash/date footer: ${commit.hash})`,
      branch,
    })
  } catch (err) {
    // The first push already succeeded and is live in Azure DevOps at this point — this failure only affects adding the footer, not whether a render happened at all. Surfaced distinctly so a caller (and whoever reads the error) knows the repo is left holding footer-less content at commit ${commit.hash} rather than assuming the render itself failed outright.
    throw new Error(
      `Rendered ${artefact.id} and pushed it to Azure DevOps as commit ${commit.hash}, but the follow-up push ` +
        `that adds the commit-hash/date footer failed: ${err.message}. ${azureDevOpsPath} in Azure DevOps still ` +
        `has the footer-less content from commit ${commit.hash} — re-render to add the footer.`
    )
  }

  return { ...result, azureDevOpsPath, commit }
}
