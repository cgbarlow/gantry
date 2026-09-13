// The one reusable dropdown (#131): a trigger button plus an absolutely-
// positioned `.menu`, closed by any click outside it or by Escape. Extracted
// from the open/close-on-outside-click pattern that was hand-rolled three
// times over (web/app.js's SettingsMenu, InstanceSwitcher, and SwimlaneChip),
// so every popup menu in this app shares exactly one implementation of
// opening, closing, and dismissal.
//
// Openness is owned by the caller (`open` in, `onOpenChange` out) rather than
// held internally — SwimlaneChip's overflow menu is deliberately controlled
// one level up (SwimlaneGroup keeps "one chip menu open at a time" per
// dashboard), and InstanceSwitcher resets its cross-workspace view on every
// fresh open. Both shapes fit the same controlled seam; an uncontrolled
// variant would have forced a second component or prop-drilled escapes.
//
// Dismissal mirrors the exact behaviour each hand-rolled version had (plus
// Escape, which InstanceSwitcher already had and the others gain for free):
// while open, a `click` anywhere on the window closes it — the trigger button
// and the menu itself stop event propagation so their own clicks never reach
// that listener — as does pressing Escape. Listeners attach only while open,
// so a closed dropdown costs nothing.
//
// Most dropdowns are purely trigger + menu (SettingsMenu, InstanceSwitcher):
// pass `body` as always-visible content rendered before the trigger, and the
// trigger + menu render in that default order. SwimlaneChip needs its own
// DOM shape though — the ⋯ trigger must sit *inside* `.chip-foot` (a flex
// row it shares with the assignee stamp) for the chip's layout to hold — so
// `body` may instead be a function receiving `{ trigger, menu }` vnodes to
// place wherever the surrounding markup needs them.
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks'
import { html } from 'htm/preact'

// The dropdowns currently open. Opening one closes the others (WI #379): each
// trigger stops its own click reaching the window, so without this a second
// dropdown's click never reaches the first one's click-outside listener. A
// dropdown opened inside another's menu leaves that outer one open.
const openDropdowns = new Set()

export function Dropdown({
  className,
  body,
  triggerLabel,
  triggerClass = 'btn small ghost',
  triggerAriaLabel,
  // Toolbar callers can prevent the trigger from stealing an editor's
  // selection before a menu command is chosen.
  triggerOnMouseDown,
  // Only SettingsMenu's hand-rolled original carried `role="menu"` on its
  // popup; kept opt-in so menus without full arrow-key navigation (e.g. the
  // instance switcher) aren't handed an ARIA contract they can't honour.
  menuRole,
  // Opt-in viewport-aware placement for menus whose normal downward position
  // can run past the bottom of the viewport.
  flipOnOverflow = false,
  open,
  onOpenChange,
  children,
}) {
  const rootRef = useRef(null)
  // Whether this render has the dropdown open. Read when another dropdown asks
  // this one to close: menus that share one open-state owner (the header's
  // Settings and Switch instance) may already be closing in the same update,
  // and closing them again would close the one just opened.
  const openRef = useRef(open)
  openRef.current = open

  useLayoutEffect(() => {
    if (!open || !flipOnOverflow) return
    const root = rootRef.current
    // Custom body layouts (such as the table picker) may contain menu buttons
    // without rendering the trigger; use the root as their placement anchor.
    const anchor = root?.querySelector('[data-dropdown-trigger="true"]') ?? root
    const menu = root?.querySelector('.menu')
    if (!anchor || !menu) return

    function updatePlacement() {
      menu.classList.remove('menu-up')
      const anchorRect = anchor.getBoundingClientRect()
      const menuHeight = menu.getBoundingClientRect().height
      const margin = 6
      const fitsBelow = anchorRect.bottom + margin + menuHeight <= window.innerHeight
      const fitsAbove = anchorRect.top - margin - menuHeight >= 0
      menu.classList.toggle('menu-up', !fitsBelow && fitsAbove)
    }

    updatePlacement()
    window.addEventListener('resize', updatePlacement)
    return () => window.removeEventListener('resize', updatePlacement)
  }, [open, flipOnOverflow])

  useEffect(() => {
    if (!open) return
    const self = {
      root: rootRef.current,
      close: () => {
        if (openRef.current) onOpenChange(false)
      },
    }
    for (const other of openDropdowns) {
      if (!other.root?.contains(self.root)) other.close()
    }
    openDropdowns.add(self)
    return () => openDropdowns.delete(self)
  }, [open, onOpenChange])

  useEffect(() => {
    if (!open) return
    function onWindowClick() {
      onOpenChange(false)
    }
    function onKeyDown(e) {
      if (e.key === 'Escape') onOpenChange(false)
    }
    window.addEventListener('click', onWindowClick)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('click', onWindowClick)
      window.removeEventListener('keydown', onKeyDown)
    }
    // Keyed on `onOpenChange` too: a caller whose closure captures per-render
    // props (SwimlaneChip pins `instance.slug`) must never dismiss through a
    // stale one if those props change while the menu stays open.
  }, [open, onOpenChange])

  const trigger = html`
    <button
      type="button"
      data-dropdown-trigger="true"
      class=${triggerClass}
      aria-haspopup="true"
      aria-expanded=${open}
      aria-label=${triggerAriaLabel}
      onMouseDown=${triggerOnMouseDown}
      onClick=${(e) => {
        e.stopPropagation()
        onOpenChange(!open)
      }}
    >
      ${triggerLabel}
    </button>
  `
  const menu =
    open
      ? html`
          <div class="menu" role=${menuRole} onClick=${(e) => e.stopPropagation()}>
            ${children}
          </div>
        `
      : null

  return html`
    <div ref=${rootRef} class=${(className ?? '') + (open ? ' menu-open' : '')}>
      ${typeof body === 'function' ? body({ trigger, menu }) : html`${body}${trigger}${menu}`}
    </div>
  `
}
