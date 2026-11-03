// #303 (ADR-0066): how a **review comment** is drawn on the Interview page. A review card is an ordinary question card (web/lib/interviewView.js
// `QuestionCard`) with what the reviewers said above its choices (`ReviewContext`), and, below them, the architect's own words and, for a comment on the
// document, the Field to assign it to (`ReviewInputs`). `ReviewSection` is the rail's panel: bring review comments in, work through them, and the
// threads resolved in Word, collapsed. The architect sees the commenters' real names here; the AI is only ever told "Reviewer 1", "Reviewer 2".
import { html } from 'htm/preact'
import { REVIEW_CHOICES } from './reviewRound.js'

const day = (iso) => String(iso ?? '').slice(0, 10)
const lines = (text) => String(text ?? '').split('\n')

/** What the reviewers said on one card, and what the Field says: their comments, replies and tracked changes, and (when it moved on) the wording at the render beside today's. */
export function ReviewContext({ card }) {
  const review = card.review
  if (!review) return null
  return html`<div class="review-context" data-testid="review-context" data-kind=${review.unitKind}>
    <p class="review-copy-name" data-testid="review-copy-name">From <strong>${review.copy.name}</strong>${review.bestGuess ? html` <span class="review-badge" data-testid="review-best-guess" title="Matched by text, to more than one Field or only loosely">Best guess</span>` : null}</p>
    ${review.sides.map(
      (side) => html`<div class="review-side" key=${side.key} data-testid="review-side" data-author=${side.author}>
        ${side.thread
          ? html`<div class="review-thread" data-testid="review-card-thread">
              ${side.thread.anchor ? html`<blockquote class="review-anchor">${side.thread.anchor}</blockquote>` : null}
              <p class="review-comment"><strong data-testid="review-author">${side.author || 'Unknown'}</strong> <span class="review-date">${day(side.thread.date)}</span></p>
              <p class="review-text" data-testid="review-text">${lines(side.thread.text).map((l, i) => html`${i ? html`<br />` : null}${l}`)}</p>
              ${side.thread.replies.length
                ? html`<ul class="review-replies">
                    ${side.thread.replies.map((r, i) => html`<li key=${`${r.id}-${i}`}><strong>${r.author || 'Unknown'}</strong> <span class="review-date">${day(r.date)}</span><br />${r.text}</li>`)}
                  </ul>`
                : null}
            </div>`
          : null}
        ${side.changes.length
          ? html`<div class="review-changes" data-testid="review-card-changes">
              <p class="review-comment">${side.thread ? '' : html`<strong>${side.author || 'Unknown'}</strong> `}tracked ${side.changes.length === 1 ? 'a change' : 'changes'}${side.thread ? '' : html` <span class="review-date">${day(side.changes[0].date)}</span>`}:</p>
              <ul>
                ${side.changes.map((c, i) => html`<li key=${i} data-kind=${c.kind}>${c.kind === 'insertion' ? html`<ins>${c.text}</ins>` : html`<del>${c.text}</del>`}</li>`)}
              </ul>
            </div>`
          : null}
      </div>`
    )}
    ${review.field
      ? review.changed
        ? html`<div class="change-compare" data-testid="review-changed">
            <div><span class="qchip">At the render</span><div class="value" data-testid="review-old">${review.rendered || '(not known)'}</div></div>
            <div><span class="qchip">Now</span><div class="value" data-testid="review-now">${review.saved || '(empty)'}</div></div>
          </div>`
        : html`<p class="kick-note" data-testid="review-unchanged">This Field is unchanged since the render.</p>`
      : null}
    ${review.agreedNote ? html`<p class="kick-note reapproval-note" data-testid="review-agreed-note" role="note">${review.agreedNote}</p>` : null}
    ${review.note ? html`<p class="kick-note" data-testid="review-landing">${review.note}</p>` : null}
  </div>`
}

/** Under a review card's choices: the Field a comment on the document is assigned to, and the architect's own words (optional, logged). */
export function ReviewInputs({ card, session, fieldTitle }) {
  const review = card.review
  if (!review) return null
  const assigning = card.selected[0] === REVIEW_CHOICES.assign
  const keeping = card.selected[0] === REVIEW_CHOICES.keep
  return html`<div class="review-inputs" data-testid="review-inputs">
    ${review.assign?.length && assigning
      ? html`<label class="review-assign">Assign it to
          <select data-testid="review-assign" value=${card.assignTo} onChange=${(e) => session.setReviewAssign(card.id, e.currentTarget.value)}>
            <option value="" selected=${!card.assignTo}>Choose a Field…</option>
            ${review.assign.map((c) => html`<option key=${c.key} value=${c.key} selected=${c.key === card.assignTo}>${c.title}</option>`)}
          </select>
        </label>`
      : null}
    <label class="review-reason">
      ${keeping ? 'Why keep it? In your own words (optional)' : 'In your own words (optional)'}
      <textarea data-testid="review-reason" rows="2" value=${card.reason} placeholder=${keeping ? 'e.g. “That belongs in the Plan, not here.”' : 'Anything to add for the AI or the log'} onInput=${(e) => session.setReviewReason(card.id, e.currentTarget.value)}></textarea>
    </label>
    ${card.field ? html`<span class="visually-hidden">Feeds ${fieldTitle(card.field)}</span>` : null}
  </div>`
}

/**
 * The rail's Review comments panel.
 *   copies         the kept Reviewed copies as `loadReviewedCopies` returns them, or null while they load
 *   plan           `planReview`'s result for this Stage, or null
 *   running        a session is under way: the questions join its next round
 *   paused         the session was paused: they join when it resumes
 *   responseCount / onDownloadResponse  how many answered comments the decisions logs hold (#304), and the download of the Review response list they make
 */
export function ReviewSection({ copies, plan, running, paused = false, joined = false, blocked = false, reviewPage = false, canOpen = true, pageStageTitle = 'this Stage', onBringIn, onWorkThrough, onJoin, onReopen, stageTitleOf = (id) => id, onOpenStage, error = '', responseCount = 0, onDownloadResponse = null }) {
  const items = plan?.items.length ?? 0
  const resolved = plan?.resolved ?? []
  const elsewhere = plan?.stages ?? []
  const copiesList = copies ?? []
  return html`<div data-testid="interview-review" class="interview-review">
    <h3 class="side">Review comments</h3>
    <button type="button" class="btn small" data-testid="interview-bring-in-review" disabled=${blocked} onClick=${onBringIn}>Bring in review comments</button>
    ${copies === null
      ? html`<p class="muted" data-testid="interview-review-loading">Reading the Reviewed copies…</p>`
      : copiesList.length === 0
        ? html`<p class="muted" data-testid="interview-review-none">No Reviewed copy has been brought in.</p>`
        : html`<ul class="review-copies" data-testid="interview-review-copies">
            ${copiesList.map(
              ({ entry, error: failed }) =>
                html`<li key=${entry.id} data-review-id=${entry.id}>${entry.name}: ${failed ? 'could not be read' : `${entry.commentsAnswered ?? 0} of ${entry.comments} answered`}</li>`
            )}
          </ul>`}
    ${error ? html`<p class="inline-error" role="alert" data-testid="interview-review-error">${error}</p>` : null}
    ${responseCount > 0 && onDownloadResponse
      ? html`<button type="button" class="btn small" data-testid="interview-response-download" onClick=${onDownloadResponse}>Download Review response list (${responseCount})</button>`
      : null}
    ${plan
      ? html`<p class="kick-note" data-testid="interview-review-count">
          ${items ? html`<strong>${items} review ${items === 1 ? 'question' : 'questions'}</strong> on ${pageStageTitle}.` : 'No review question waits on this Stage.'}
        </p>`
      : null}
    ${plan?.deferred?.length
      ? html`<p class="kick-note" data-testid="interview-review-deferred">${plan.deferred.length} review ${plan.deferred.length === 1 ? 'comment' : 'comments'} on a drafted-ahead Stage stay unanswered: a drafted-ahead branch is never changed. Ask them once it is the current Stage.</p>`
      : null}
    ${elsewhere.length
      ? html`<p class="kick-note" data-testid="interview-review-next">
          ${elsewhere.map((st) => html`<span key=${st.stageId}>${st.count} more on ${stageTitleOf(st.stageId)} <button type="button" class="btn small ghost" data-testid="interview-review-goto" onClick=${() => onOpenStage?.(st.stageId)}>Go to ${stageTitleOf(st.stageId)}</button> </span>`)}
        </p>`
      : null}
    ${items && !reviewPage
      ? running
        ? html`<button type="button" class="btn small primary" data-testid="interview-review-join" disabled=${blocked || joined} onClick=${onJoin}>${joined ? 'In the next round' : `Add ${items} to the interview's next round`}</button>`
        : paused
          ? html`<button type="button" class="btn small primary" data-testid="interview-review-join-later" disabled=${joined} onClick=${onJoin}>${joined ? 'They will join when you resume' : `Add ${items} when the interview resumes`}</button>`
          : html`<button type="button" class="btn small primary" data-testid="interview-review-start" disabled=${blocked || !canOpen} onClick=${onWorkThrough}>Work through review comments</button>`
      : null}
    ${resolved.length
      ? html`<details class="review-resolved" data-testid="interview-review-resolved">
          <summary>${resolved.length} resolved in Word (not asked)</summary>
          <ul>
            ${resolved.map(
              (r) => html`<li key=${r.key} data-testid="interview-review-resolved-item" data-thread=${r.key}>
                <strong>${r.thread.author || 'Unknown'}</strong>${r.field ? html` on ${r.field.fieldTitle}` : null}: ${r.thread.text}
                ${r.answered ? html`<span class="review-badge">Answered</span>` : html`<button type="button" class="btn small ghost" data-testid="interview-review-reopen" onClick=${() => onReopen?.(r.key)}>Ask about this</button>`}
              </li>`
            )}
          </ul>
        </details>`
      : null}
  </div>`
}
