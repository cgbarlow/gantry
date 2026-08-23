import { parse as parseYAML } from 'yaml'
import { loadDefinition } from './definition.js'
import {
  readModule,
  azureDevOpsInstancePath,
  azureDevOpsModulePath,
  AZURE_DEVOPS_WORKSPACE_ROOT,
  LEGACY_AZURE_DEVOPS_INSTANCE_PATH,
  LEGACY_AZURE_DEVOPS_MODULES_DIR,
} from './instance.js'
import { evaluateStage } from './status.js'
import { createAzureDevOpsClient, AzureDevOpsNotFoundError, AzureDevOpsAuthenticationError } from './azureDevOpsClient.js'
import { isValidSlug } from './slug.js'

/**
 * Migrates a pre-#100 Azure-DevOps-backed instance's data — `instance.yaml`
 * and every file under `modules/` — from the legacy repo-root layout to
 * `gantry-workspace/<slug>/`, per docs/adr/0009. Each module's new copy is
 * written before its own old copy is deleted, so a repo is never left
 * holding a given module's data at both locations at once — but the
 * legacy root `instance.yaml` itself is a deliberate exception to that
 * "delete as soon as the new copy lands" rule; see the "Critically, ..."
 * paragraph below for why. `instanceYamlText` is the already-fetched
 * legacy `instance.yaml` content (the caller, `checkAzureDevOpsRepo` below,
 * already had to read it to discover `slug` in the first place — no reason
 * to fetch it twice).
 *
 * Exported so this is also usable as an explicit, caller-invoked migration
 * routine on its own (per #100's acceptance criteria: migration may happen
 * "on adoption/first access", via `checkAzureDevOpsRepo`'s own call below,
 * "or via an explicit migration routine" — this function *is* that
 * routine, regardless of which path calls it).
 *
 * Not atomic — the same accepted limitation `createInstance`'s own Azure
 * DevOps path (lib/instance.js) already has: each file is moved as its own
 * write-then-delete pair of pushes, so a failure partway through (a
 * network blip, an expired PAT) can leave some files already moved and
 * others still at the legacy root path.
 *
 * Critically, the legacy root `instance.yaml` — the *only* signal
 * `checkAzureDevOpsRepo` uses to decide "this repo still needs migrating"
 * — is deleted **last**, only once every module file has been safely
 * migrated. Deleting it any earlier (e.g. right after writing the new
 * instance.yaml, before the modules loop even starts) would mean a failure
 * partway through the modules loop leaves the repo looking "fully
 * migrated" to any later check, permanently stranding whichever module
 * files hadn't been reached yet — silently reported thereafter as "no
 * saved data" instead of the real, previously-saved content they still
 * hold at their orphaned legacy path. Keeping the root `instance.yaml`
 * around until the very end means a retry after a transient failure
 * re-enters this same function (via `checkAzureDevOpsRepo`'s own "found a
 * legacy instance.yaml" branch) and finishes whatever remains — `writeFile`
 * is a harmless no-op re-write for anything already migrated, and
 * `listFolder` only ever returns modules that are genuinely still at the
 * legacy path, so nothing already-migrated is reprocessed.
 *
 * The root `instance.yaml` delete itself tolerates the file already being
 * gone (`AzureDevOpsNotFoundError`) rather than treating that as a
 * failure — this function is also invoked directly, independent of
 * `checkAzureDevOpsRepo`, as its own "explicit migration routine" entry
 * point, so calling it again against an already-fully-migrated repo (e.g.
 * a caller retrying after an earlier attempt's final delete itself failed
 * partway through pushing but actually landed, or simply calling it twice
 * defensively) must not throw.
 *
 * `branch` (#118) — every read/write above targets this same branch,
 * falling through to the client's own `'main'` default when omitted, so
 * every existing caller (which never passed one) is unaffected.
 */
export async function migrateLegacyAzureDevOpsInstance(client, slug, instanceYamlText, branch) {
  await client.writeFile(azureDevOpsInstancePath(slug), instanceYamlText, {
    message: `Migrate instance "${slug}" to ${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/`,
    branch,
  })

  const legacyModuleItems = await client.listFolder(LEGACY_AZURE_DEVOPS_MODULES_DIR, { branch })
  for (const item of legacyModuleItems) {
    if (item.isFolder) continue
    const fileName = item.path.split('/').pop()
    const moduleId = fileName.replace(/\.md$/, '')
    const content = await client.getFileContent(item.path, { branch })
    await client.writeFile(azureDevOpsModulePath(slug, moduleId), content, {
      message: `Migrate module "${moduleId}" for instance "${slug}" to ${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/modules/`,
      branch,
    })
    await client.deleteFile(item.path, {
      message: `Remove legacy module "${moduleId}" for "${slug}" (migrated to ${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/modules/)`,
      branch,
    })
  }

  // Only now — after every module file has been confirmed migrated — is
  // the legacy root instance.yaml removed. Checked for existence first
  // (rather than a bare delete) so a second call against an already-fully-
  // migrated repo (this delete having already succeeded once) is a no-op,
  // not an error, regardless of how the real Azure DevOps API happens to
  // respond to a delete of a path that's already gone.
  const legacyInstanceYamlStillPresent = await client
    .getFileContent(LEGACY_AZURE_DEVOPS_INSTANCE_PATH, { branch })
    .then(() => true)
    .catch((err) => {
      if (err instanceof AzureDevOpsNotFoundError) return false
      throw err
    })
  if (legacyInstanceYamlStillPresent) {
    await client.deleteFile(LEGACY_AZURE_DEVOPS_INSTANCE_PATH, {
      message: `Remove legacy root-level instance.yaml for "${slug}" (migrated to ${AZURE_DEVOPS_WORKSPACE_ROOT}/${slug}/)`,
      branch,
    })
  }
}

/**
 * Checks whether an Azure DevOps location (`organization`, `project`,
 * `repository`, optional `baseUrl`) already holds instance data, given a
 * caller-supplied PAT — the read-only "what's in this specific remote
 * repo" check the instance-setup wizard (#78) needs (#90, under #88).
 *
 * Deliberately does not consult or update gantry's own instance registry
 * (lib/registry.js, #89) — that answers "is this already known to gantry"
 * for locally-registered instances, a different question from this one.
 *
 * Since #100, instance data lives at `gantry-workspace/<slug>/` rather
 * than repo root, and one repo ("workspace") can hold more than one
 * instance. This still looks first for a legacy repo-root `instance.yaml`
 * (a repo never migrated since before #100) and, if found, migrates it in
 * place (`migrateLegacyAzureDevOpsInstance` above) before proceeding —
 * "on first access" migration, satisfying #100's acceptance criteria with
 * no separate manual step. Otherwise it lists `gantry-workspace/` itself
 * to discover what's already there.
 *
 * Resolves to one of:
 *   - `{ result: 'found', slug, definition, stage, status, assignee }` — an
 *     instance exists at this location (whether freshly migrated from the
 *     legacy root path, or already at `gantry-workspace/<slug>/`); `status`
 *     is 'complete' or 'incomplete' for the instance's current stage (the
 *     same rollup `lib/registry.js`'s `listRegistry` reports for local
 *     instances), and `assignee` is that instance record's own stored
 *     assignee (#97), or ''.
 *   - `{ result: 'empty', message }` — the location is reachable (Azure
 *     DevOps didn't reject the PAT) but holds no instance data yet.
 *   - `{ result: 'multiple', slugs, message }` — the location already
 *     holds more than one instance under `gantry-workspace/`. Discovering
 *     "the one instance in this repo" (this function's whole contract,
 *     inherited from the pre-#100 one-repo-per-instance model) is
 *     ambiguous when there's more than one; picking a specific slug to
 *     check needs its own caller-supplied-slug entry point, which is
 *     deliberately left for a later ticket (the settings/multi-instance UI
 *     work, #101/#104) rather than guessed at here.
 *
 * Throws `AzureDevOpsAuthenticationError` if Azure DevOps rejects the PAT —
 * left for the caller (lib/server.js's `withAzureDevOpsCredential`) to fold
 * into the same structured `authentication_required` response every other
 * Azure-DevOps-backed route uses; any other error (a network failure, an
 * unknown `definition`/`stage` in a malformed `instance.yaml`, etc.)
 * propagates as a genuine error for the caller's own generic error handling.
 *
 * `branch` (#118) — every read below (and the migration this triggers, and
 * the `evaluateStage` call it makes) targets this same branch, falling
 * through to the client's own `'main'` default when omitted, so every
 * existing caller (which never passed one) is unaffected.
 */
export async function checkAzureDevOpsRepo({ organization, project, repository, baseUrl, pat, branch, definitionsDir }) {
  const client = createAzureDevOpsClient({ organization, project, repository, pat, baseUrl })

  let slug
  let legacyText
  try {
    legacyText = await client.getFileContent(LEGACY_AZURE_DEVOPS_INSTANCE_PATH, { branch })
  } catch (err) {
    if (!(err instanceof AzureDevOpsNotFoundError)) throw err
  }

  // Reports a legacy root-level instance.yaml as "found" without migrating
  // it or evaluating its stage/owner against any storage location — used
  // for both a missing slug and an invalid one (below), where there is
  // either no gantry-workspace/<slug>/ destination to migrate to (no slug
  // at all) or one that must never be built from untrusted input (a
  // malformed/adversarial slug). The raw (possibly empty, possibly
  // malformed) `slug` value is still returned, unchanged, so the caller's
  // own validation (`POST /api/instances/adopt`'s "no slug set"/isValidSlug
  // checks) can reject it exactly as it did before #100 — the pre-existing
  // security-regression coverage this preserves.
  function unresolvedLegacyResult(legacyInstance, rawSlug) {
    const definition = loadDefinition(legacyInstance.definition, { definitionsDir })
    const stage = definition.stages.find((s) => s.id === legacyInstance.stage)
    if (!stage) {
      throw new Error(
        `Instance at Azure DevOps ${organization}/${project}/${repository} has unknown stage "${legacyInstance.stage}"`
      )
    }
    return { result: 'found', slug: rawSlug, definition: definition.id, stage: stage.id, status: 'incomplete', owner: '' }
  }

  if (legacyText !== undefined) {
    const legacyInstance = parseYAML(legacyText) ?? {}
    if (!legacyInstance.slug) {
      return unresolvedLegacyResult(legacyInstance, '')
    }
    if (!isValidSlug(legacyInstance.slug)) {
      return unresolvedLegacyResult(legacyInstance, legacyInstance.slug)
    }
    slug = legacyInstance.slug
    await migrateLegacyAzureDevOpsInstance(client, slug, legacyText, branch)
  } else {
    const entries = await client.listFolder(AZURE_DEVOPS_WORKSPACE_ROOT, { branch })
    const slugs = entries
      .filter((item) => item.isFolder)
      .map((item) => item.path.split('/').pop())
      .sort()
    if (slugs.length === 0) {
      return { result: 'empty', message: 'No instance data found at this location yet.' }
    }
    if (slugs.length > 1) {
      return {
        result: 'multiple',
        slugs,
        message:
          `This Azure DevOps location already holds more than one instance (${slugs.join(', ')}) — ` +
          'checking a specific one requires a slug, which this check does not yet accept.',
      }
    }
    slug = slugs[0]
  }

  let text
  try {
    text = await client.getFileContent(azureDevOpsInstancePath(slug), { branch })
  } catch (err) {
    if (err instanceof AzureDevOpsNotFoundError) {
      return { result: 'empty', message: 'No instance data found at this location yet.' }
    }
    throw err
  }

  const instance = parseYAML(text) ?? {}
  const definition = loadDefinition(instance.definition, { definitionsDir })
  const stage = definition.stages.find((s) => s.id === instance.stage)
  if (!stage) {
    throw new Error(
      `Instance at Azure DevOps ${organization}/${project}/${repository} has unknown stage "${instance.stage}"`
    )
  }

  const azureDevOps = { organization, project, repository, pat, baseUrl, branch }
  const { complete } = await evaluateStage(definition, stage, slug, { azureDevOps })

  return {
    result: 'found',
    slug,
    definition: definition.id,
    stage: stage.id,
    status: complete ? 'complete' : 'incomplete',
    // The instance record's own stored `assignee` (#97) — no longer
    // derived by scanning the current stage's modules for a first
    // non-empty frontmatter `owner`.
    assignee: instance.assignee ?? '',
  }
}
