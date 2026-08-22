import { parse as parseYAML } from 'yaml'
import { loadDefinition } from './definition.js'
import { readModule } from './instance.js'
import { evaluateStage } from './status.js'
import { createAzureDevOpsClient, AzureDevOpsNotFoundError, AzureDevOpsAuthenticationError } from './azureDevOpsClient.js'

// Same fixed repo-relative path lib/instance.js's Azure-DevOps-backed
// readInstance/createInstance use — per docs/adr/0005, the whole repo *is*
// the instance, so this is the one file whose presence answers "does this
// location already hold instance data".
const AZURE_DEVOPS_INSTANCE_PATH = 'instance.yaml'

// The current stage's modules are usually filled in by the same person/team
// — this returns the first non-empty `owner` found among them, in
// stage-definition order, mirroring lib/registry.js's local-filesystem
// `stageOwner` but reading each module from Azure DevOps (via readModule)
// instead of the local instancesDir. '' if none of them have an owner set
// yet (or none exist in the repo).
async function stageOwner(definition, stage, slug, azureDevOps) {
  for (const moduleId of stage.modules) {
    try {
      const { owner } = await readModule(definition, slug, moduleId, { azureDevOps })
      if (owner) return owner
    } catch (err) {
      if (err instanceof AzureDevOpsAuthenticationError) throw err
      // Only readModule's own "no saved data yet" miss is treated as "this
      // module has no owner to contribute" — a genuine read failure (a
      // network error, an Azure DevOps outage, malformed module content)
      // must propagate as a real error instead of being silently skipped.
      if (!/has no saved data/.test(err.message)) throw err
    }
  }
  return ''
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
 * Resolves to one of:
 *   - `{ result: 'found', slug, definition, stage, status, owner }` — an
 *     `instance.yaml` exists at this location; `status` is 'complete' or
 *     'incomplete' for the instance's current stage (the same rollup
 *     `lib/registry.js`'s `listRegistry` reports for local instances), and
 *     `owner` is that stage's first non-empty module owner, or ''.
 *   - `{ result: 'empty', message }` — the location is reachable (Azure
 *     DevOps didn't reject the PAT) but has no `instance.yaml` yet.
 *
 * Throws `AzureDevOpsAuthenticationError` if Azure DevOps rejects the PAT —
 * left for the caller (lib/server.js's `withAzureDevOpsCredential`) to fold
 * into the same structured `authentication_required` response every other
 * Azure-DevOps-backed route uses; any other error (a network failure, an
 * unknown `definition`/`stage` in a malformed `instance.yaml`, etc.)
 * propagates as a genuine error for the caller's own generic error handling.
 */
export async function checkAzureDevOpsRepo({ organization, project, repository, baseUrl, pat, definitionsDir }) {
  const client = createAzureDevOpsClient({ organization, project, repository, pat, baseUrl })

  let text
  try {
    text = await client.getFileContent(AZURE_DEVOPS_INSTANCE_PATH)
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

  const azureDevOps = { organization, project, repository, pat, baseUrl }
  const { complete } = await evaluateStage(definition, stage, instance.slug, { azureDevOps })
  const owner = await stageOwner(definition, stage, instance.slug, azureDevOps)

  return {
    result: 'found',
    slug: instance.slug ?? '',
    definition: definition.id,
    stage: stage.id,
    status: complete ? 'complete' : 'incomplete',
    owner,
  }
}
