// #285 (docs/adr/0065): the read-only "Gantry's interview rules" view — drawn beside the Interview
// instructions editor on the server Definitions page and in the Local Workspace Definition editor, so an
// author writing instructions can see what they are adding to: the fixed rules, the two bundled skills
// with their versions and credit, how the skills' terms map onto Gantry's, and where a skill and a rule
// clash and how that is settled. Nothing here is editable; it is the same text the AI is given
// (web/lib/interviewBrief.js).
import { html } from 'htm/preact'
import { INTERVIEW_RULES, INTERVIEW_RULES_VERSION } from './interviewRules.js'
import { INTERVIEW_SKILLS, INTERVIEW_SKILLS_URL, interviewSkillsCredit } from './interviewSkills.js'
import { ADAPTER_MAPPINGS, ADAPTER_CONFLICTS } from './interviewAdapter.js'

export function InterviewRules() {
  return html`
    <details class="defn-focus-section defn-interview-rules" data-testid="interview-rules">
      <summary>
        <span class="kicker">Gantry's interview rules</span>
        <span class="defn-interview-rules-versions" data-testid="interview-rules-versions">rules ${INTERVIEW_RULES_VERSION} · ${INTERVIEW_SKILLS.package} ${INTERVIEW_SKILLS.version}</span>
      </summary>
      <p class="guidance defn-hint">
        These are Gantry's own rules for how the AI interviews an architect. They are fixed and apply to every Definition. Interview
        instructions add to them and can never override them. Read-only.
      </p>
      <ol class="defn-interview-rules-list">
        ${INTERVIEW_RULES.map((rule) => html`<li key=${rule.id} data-testid="interview-rule"><strong>${rule.title}.</strong> ${rule.text}</li>`)}
      </ol>

      <h3 class="defn-interview-rules-h">Skills</h3>
      <p class="guidance defn-hint">
        After Gantry's rules, the AI follows these two skills, bundled unchanged at a pinned version. A Gantry release moves to a
        newer version on purpose.
      </p>
      <ul class="defn-interview-rules-skills" data-testid="interview-skills">
        ${INTERVIEW_SKILLS.skills.map(
          (skill) => html`
            <li key=${skill.id} data-testid=${`interview-skill-${skill.id}`}>
              <strong>${skill.title}</strong> <code>${skill.id}</code> · version ${INTERVIEW_SKILLS.version} ·
              ${skill.files.map((file, i) => html`${i ? ', ' : ''}<a href=${`${INTERVIEW_SKILLS_URL}/${file.path}`} target="_blank" rel="noopener">${file.path.split('/').pop()}</a>`)}
            </li>
          `
        )}
      </ul>
      <p class="defn-interview-rules-credit" data-testid="interview-skills-credit">
        ${interviewSkillsCredit()} <a href=${`${INTERVIEW_SKILLS_URL}/${INTERVIEW_SKILLS.licence.file}`} target="_blank" rel="noopener">Licence</a>.
      </p>

      <details class="defn-interview-rules-more">
        <summary>How the skills' terms map onto Gantry's</summary>
        <ul>
          ${ADAPTER_MAPPINGS.map((mapping) => html`<li key=${mapping.id}>${mapping.skillTerms.join('; ')} mean ${mapping.gantry}</li>`)}
        </ul>
      </details>
      <details class="defn-interview-rules-more">
        <summary>Where a skill and a rule clash, and how it is settled</summary>
        <ul>
          ${ADAPTER_CONFLICTS.map((conflict) => html`<li key=${conflict.id}>${conflict.skill} <strong>Gantry settles it:</strong> ${conflict.settled}</li>`)}
        </ul>
      </details>
    </details>
  `
}
