const STAGES_MARKER = '<!-- GANTRY-DESIGN-STAGES -->'
const ARTEFACTS_MARKER = '<!-- GANTRY-DESIGN-ARTEFACTS -->'

function code(value) {
  return `\`${String(value).replaceAll('`', '\\`')}\``
}

function purpose(item) {
  return item.purpose?.trim() || 'No purpose is defined for this item.'
}

function renderStages(definition) {
  const stages = definition.stages
    .map((stage) => [
      `#### ${stage.title} (${code(stage.id)})`,
      '',
      purpose(stage),
      '',
      `Its exit gate is ${code(stage.gate)}.`,
    ].join('\n'))
    .join('\n\n')

  return [`### Stages in the ${code(definition.id)} definition`, '', stages].join('\n')
}

function renderArtefacts(definition) {
  const artefacts = definition.artefacts
    .map((artefact) => [
      `#### ${artefact.title} (${code(artefact.id)})`,
      '',
      purpose(artefact),
      '',
      `- Gate: ${code(artefact.gate)}`,
      '- Requires:',
      ...artefact.requires.map((requirement) => `  - ${code(requirement)}`),
    ].join('\n'))
    .join('\n\n')

  return [`### Artefacts in the ${code(definition.id)} definition`, '', artefacts].join('\n')
}

/**
 * Expands the definition-backed reference sections in the authored guide.
 * The surrounding guide remains markdown so the existing client renderer can
 * continue to own presentation and sanitization.
 */
export function renderUserGuide(markdown, definition) {
  return markdown
    .replace(STAGES_MARKER, renderStages(definition))
    .replace(ARTEFACTS_MARKER, renderArtefacts(definition))
}
