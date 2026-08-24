import { findDefinitionProblems } from './definition.js'

/**
 * `gantry validate <definitionId>`: reports every structural problem with a definition in one pass, instead of `loadDefinition`'s fail-fast behavior (fix one YAML error, rerun, hit the next).
 */
export function validateDefinition(definitionId, options = {}) {
  const problems = findDefinitionProblems(definitionId, options)
  return { definition: definitionId, valid: problems.length === 0, problems }
}
