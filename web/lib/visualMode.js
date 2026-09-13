// The Visual view (#374, docs/adr/0033): a layer of CodeMirror decorations and
// widgets over the same editor that edits the raw markdown. There is no second
// document and no serializer — the GFM text stays the document, and every
// action here is a change to that text (docs/adr/0017, 0018). An unedited field
// therefore saves byte-for-byte; a cell edit rewrites only its own segment.
//
// Lifted from the WI #373 prototype (branch prototype/wi373-visual-mode), whose
// findings shape the pieces below:
// - the layer is a StateField, because CodeMirror refuses block decorations
//   (the table grid) from a view plugin;
// - typing in a grid cell is annotated `fromCell`, and the field maps its
//   decorations through that change instead of rebuilding, so the cell's DOM —
//   and the caret inside it — survive the keystroke;
// - cell typing is a user `input.type` event, or history would undo one
//   character at a time;
// - focus inside a cell is invisible to CodeMirror's selection, so the
//   "active cell" is remembered here and commands resolve positions through it.
import { EditorView, Decoration, WidgetType } from '@codemirror/view'
import { StateField, StateEffect, Annotation, Facet } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { undo, redo, isolateHistory } from '@codemirror/commands'
import {
  apply as applyMarkdownCommand,
  diffRange,
  findAllTables,
  findTable,
  tableCellEdit,
  tableCellSourceOffset,
  tableCellText,
} from './markdownCommands.js'

const fromCell = Annotation.define()

// Re-draw every widget — e.g. once an image's source citation or local file URL
// has loaded, which the document itself gives no signal for.
export const refreshVisual = StateEffect.define()

// `renderMarkdown(node, markdown)` draws images and diagrams exactly as the rest
// of the app renders markdown; `historyView()` names the editor whose undo
// history this one shares (Split's Visual pane undoes through the source pane).
const visualConfig = Facet.define({ combine: (values) => values[0] ?? {} })

const historyTarget = (view) => view.state.facet(visualConfig).historyView?.() ?? view

// ---------- which tables are drawn ----------

// Pipes inside a fenced code block are code, not a table.
function codeRanges(state) {
  const ranges = []
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        ranges.push([node.from, node.to])
        return false
      }
      return undefined
    },
  })
  return ranges
}

function visualTables(state, ranges = codeRanges(state)) {
  return findAllTables(state.doc.toString()).filter((t) => !ranges.some(([a, b]) => t.start >= a && t.start < b))
}

// Where a widget sits in the document right now — a grid that survived a cell
// edit elsewhere has moved, so positions are never cached on the widget.
function widgetPos(view, node) {
  try {
    return view.posAtDOM(node)
  } catch {
    return -1
  }
}

function tableIndexOf(view, wrap) {
  const pos = widgetPos(view, wrap)
  return visualTables(view.state).findIndex((t) => t.start === pos)
}

// ---------- the active cell ----------

const activeCells = new WeakMap()

export function clearActiveCell(view) {
  if (view) activeCells.delete(view)
}

function focusCell(node, { atEnd = true } = {}) {
  node.focus()
  const range = document.createRange()
  range.selectNodeContents(node)
  range.collapse(!atEnd)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
}

function cellNode(view, cell) {
  const t = visualTables(view.state)[cell.index]
  if (!t) return null
  const wrap = [...view.dom.querySelectorAll('.vgrid-wrap')].find((w) => widgetPos(view, w) === t.start)
  if (!wrap) return null
  let row = Math.min(cell.row, t.segs.length - 1)
  if (row === t.delimIndex) row = t.delimIndex - 1
  const col = Math.min(cell.col, t.colCount - 1)
  return wrap.querySelector(`[data-row="${row}"][data-col="${col}"]`)
}

// Put the author back in the cell they were in — after a structural change
// has redrawn the grid, or an undo has taken focus away.
export function restoreActiveCell(view) {
  const cell = view && activeCells.get(view)
  if (!cell) return false
  const node = cellNode(view, cell)
  if (node) focusCell(node)
  return !!node
}

// Hand focus to the grid cell holding document position `pos` (used after a
// table is inserted from the toolbar). False when Visual is off or no drawn
// table holds `pos`.
export function focusTableCellAt(view, pos) {
  if (!view?.state.field(visualField, false)) return false
  const text = view.state.doc.toString()
  const index = visualTables(view.state).findIndex((t) => pos >= t.start && pos <= t.end)
  const t = index === -1 ? null : findTable(text, pos)
  if (!t) return false
  activeCells.set(view, { index, row: t.rowIndex, col: t.colIndex })
  requestAnimationFrame(() => restoreActiveCell(view))
  return true
}

// The document range the author has selected inside the focused grid cell, or
// null when focus is not in a cell of this editor.
export function activeCellSelection(view) {
  const cell = view && activeCells.get(view)
  const node = document.activeElement
  if (!cell || !node?.dataset?.row || !view.dom.contains(node)) return null
  const t = visualTables(view.state)[cell.index]
  const seg = t?.segs[cell.row]?.[cell.col]
  if (!seg) return null
  const sel = window.getSelection()
  let start = node.textContent.length
  let end = start
  if (sel.rangeCount && node.contains(sel.anchorNode)) {
    const range = sel.getRangeAt(0)
    const measure = (container, offset) => {
      const probe = document.createRange()
      probe.selectNodeContents(node)
      probe.setEnd(container, offset)
      return probe.toString().length
    }
    start = measure(range.startContainer, range.startOffset)
    end = measure(range.endContainer, range.endOffset)
  }
  return {
    from: seg.contentStart + tableCellSourceOffset(seg.text, start),
    to: seg.contentStart + tableCellSourceOffset(seg.text, end),
  }
}

// ---------- changes ----------

// A whole-document command result lands as the one change that differs, then
// the author is put back in their cell once the grid has redrawn.
function dispatchResult(view, result, cell) {
  if (!result) return false
  const change = diffRange(view.state.doc.toString(), result.text)
  view.dispatch({
    changes: change,
    selection: { anchor: Math.min(result.from, result.text.length) },
    userEvent: 'input',
    // A menu action or drag is one undo step of its own.
    annotations: isolateHistory.of('full'),
  })
  if (cell) activeCells.set(view, cell)
  requestAnimationFrame(() => restoreActiveCell(view))
  return true
}

function runTableCommand(view, wrap, name, row, col, extra = {}, cell) {
  if (!view.state.facet(EditorView.editable)) return false
  const index = tableIndexOf(view, wrap)
  const t = visualTables(view.state)[index]
  const seg = t?.segs[row]?.[col]
  if (!seg) return false
  const text = view.state.doc.toString()
  const result = applyMarkdownCommand(name, { tree: null, text, from: seg.contentStart, to: seg.contentStart, ...extra })
  return dispatchResult(view, result, cell ? { index, ...cell } : null)
}

function writeCell(view, wrap, row, col, value) {
  const t = visualTables(view.state)[tableIndexOf(view, wrap)]
  if (!t) return
  const change = tableCellEdit({ text: view.state.doc.toString(), from: t.start, row, col, value })
  if (!change) return
  view.dispatch({ changes: change, annotations: fromCell.of(true), userEvent: 'input.type' })
}

function runHistory(view, command) {
  command(historyTarget(view))
  requestAnimationFrame(() => restoreActiveCell(view))
}

// Leaving the grid by keyboard: the caret lands on the line just outside it.
function leaveTable(view, t, direction) {
  const doc = view.state.doc
  const anchor = direction < 0 ? Math.max(t.start - 1, 0) : Math.min(t.end + 1, doc.length)
  clearActiveCell(view)
  view.focus()
  view.dispatch({ selection: { anchor }, scrollIntoView: true })
}

// The inline formats a cell can carry, by shortcut — the same keys the editor
// binds for its text (Ctrl/Cmd+B, I, E, K and Shift+X).
function cellShortcut(e) {
  const key = e.key.toLowerCase()
  if (e.shiftKey) return key === 'x' ? 'strikethrough' : null
  return { b: 'bold', i: 'italic', e: 'inlineCode', k: 'link' }[key] ?? null
}

function formatCell(view, name) {
  const range = activeCellSelection(view)
  const cell = activeCells.get(view)
  if (!range || !cell || !view.state.facet(EditorView.editable)) return
  const text = view.state.doc.toString()
  const result = applyMarkdownCommand(name, { tree: syntaxTree(view.state), text, from: range.from, to: range.to })
  dispatchResult(view, result, cell)
}

function onCellKey(e, view, wrap, row, col) {
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  // The screen-wide view hotkey (Ctrl+Shift+V) still reaches the page; every
  // other key stays in the cell, or the editor around the grid would act on
  // its own selection (select-all, bold, undo…) instead of the cell's.
  if (!(mod && e.shiftKey && key === 'v')) e.stopPropagation()
  if (mod && key === 'a') {
    e.preventDefault()
    const node = e.currentTarget
    const range = document.createRange()
    range.selectNodeContents(node)
    const sel = window.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    return
  }
  const format = mod ? cellShortcut(e) : null
  if (format) {
    e.preventDefault()
    formatCell(view, format)
    return
  }
  if (mod && key === 'z') {
    e.preventDefault()
    runHistory(view, e.shiftKey ? redo : undo)
    return
  }
  if (mod && key === 'y') {
    e.preventDefault()
    runHistory(view, redo)
    return
  }
  if (e.key === 'Enter') {
    // A line break would split the row; a cell is one line of text.
    e.preventDefault()
    return
  }
  const index = tableIndexOf(view, wrap)
  const t = visualTables(view.state)[index]
  if (!t) return
  if (e.key === 'Escape') {
    e.preventDefault()
    leaveTable(view, t, 1)
    return
  }
  if (e.key === 'ArrowUp' && row === 0) {
    e.preventDefault()
    leaveTable(view, t, -1)
    return
  }
  if (e.key === 'ArrowDown' && row === t.lines.length - 1) {
    e.preventDefault()
    leaveTable(view, t, 1)
    return
  }
  if (e.key !== 'Tab') return
  e.preventDefault()
  const forward = !e.shiftKey
  let nextRow = row
  let nextCol = col + (forward ? 1 : -1)
  if (nextCol >= t.colCount) {
    nextCol = 0
    nextRow = row + 1 === t.delimIndex ? row + 2 : row + 1
  } else if (nextCol < 0) {
    nextCol = t.colCount - 1
    nextRow = row - 1 === t.delimIndex ? row - 2 : row - 1
  }
  if (nextRow < 0) return
  if (nextRow < t.lines.length) {
    const node = wrap.querySelector(`[data-row="${nextRow}"][data-col="${nextCol}"]`)
    if (node) {
      activeCells.set(view, { index, row: nextRow, col: nextCol })
      focusCell(node)
    }
    return
  }
  // Tab off the last cell grows the table and lands in the new row.
  if (forward && view.state.facet(EditorView.editable)) {
    runTableCommand(view, wrap, 'tableAddRowBelow', t.lines.length - 1, 0, {}, { row: t.lines.length, col: 0 })
  }
}

// ---------- menus ----------

let openMenuEl = null
let onMenuClose = null
let documentListeners = false

function closeMenu() {
  openMenuEl?.remove()
  openMenuEl = null
  const done = onMenuClose
  onMenuClose = null
  done?.()
}

function ensureDocumentListeners() {
  if (documentListeners) return
  documentListeners = true
  document.addEventListener('pointerdown', (e) => {
    if (openMenuEl && !openMenuEl.contains(e.target)) closeMenu()
    const pop = document.querySelector('.vgrid-popover')
    if (pop && !pop.contains(e.target)) pop.remove()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return
    closeMenu()
    document.querySelector('.vgrid-popover')?.remove()
  })
}

// Menus and pop-overs float above the page; while a field is full screen only
// the full-screen element is painted, so they live inside it then.
const overlayParent = () => document.fullscreenElement ?? document.body

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function openMenu(anchor, label, items, onClose) {
  closeMenu()
  ensureDocumentListeners()
  const rect = anchor.getBoundingClientRect()
  const menu = el('div', 'vgrid-menu')
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', label)
  for (const item of items) {
    if (item === '-') {
      menu.appendChild(el('hr'))
      continue
    }
    const button = el('button', item.danger ? 'danger' : '', item.label)
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.addEventListener('mousedown', (e) => e.preventDefault())
    button.addEventListener('click', () => {
      closeMenu()
      item.act()
    })
    menu.appendChild(button)
  }
  menu.style.top = Math.max(Math.min(rect.bottom + 4, window.innerHeight - 200), 0) + 'px'
  menu.style.left = Math.max(Math.min(rect.left, window.innerWidth - 230), 0) + 'px'
  overlayParent().appendChild(menu)
  openMenuEl = menu
  onMenuClose = onClose
}

// A handle press is a click when the pointer barely moves and a drag once it
// travels more than a few pixels. `hit(x, y)` names the index under the
// pointer, `mark(i)` shows the drop target, `drop(i)` completes a drag.
const DRAG_THRESHOLD = 5

function handlePointer(handle, { hit, mark, drop, pick }) {
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    closeMenu()
    const x0 = e.clientX
    const y0 = e.clientY
    let dragging = false
    let target = null
    handle.setPointerCapture?.(e.pointerId)
    const move = (ev) => {
      if (!dragging && Math.hypot(ev.clientX - x0, ev.clientY - y0) > DRAG_THRESHOLD) {
        dragging = !!drop
        if (dragging) handle.classList.add('dragging')
      }
      if (!dragging) return
      const next = hit(ev.clientX, ev.clientY)
      if (next !== target) {
        target = next
        mark(target)
      }
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      handle.classList.remove('dragging')
      mark(null)
      if (dragging) {
        if (target !== null) drop(target)
      } else {
        pick()
      }
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  })
}

// ---------- the table grid ----------

const ALIGN_LABEL = { left: 'left', center: 'centre', right: 'right' }

const CELL_OWNED_EVENTS = ['keypress', 'keyup', 'beforeinput', 'paste', 'copy', 'cut', 'drop', 'compositionstart', 'compositionupdate', 'compositionend']

// A grid depends only on its own text: it is never redrawn by a refresh, so an
// image citation loading elsewhere cannot pull the caret out of a cell.
//
// Deliberately NOT a CodeMirror "editable" widget: that flag drops the
// contenteditable=false boundary CodeMirror puts around a widget, and the
// cells' own contenteditable would then fold into the editor's, sending every
// click and keystroke to the surrounding text instead of the cell.
class TableGridWidget extends WidgetType {
  constructor(source, canEdit) {
    super()
    this.source = source
    this.canEdit = canEdit
  }

  eq(other) {
    return other.source === this.source && other.canEdit === this.canEdit
  }

  ignoreEvent() {
    return true
  }

  toDOM(view) {
    const wrap = el('div', 'vgrid-wrap')
    const t = findTable(this.source, 0)
    if (!t) return wrap
    const editable = this.canEdit
    if (!editable) wrap.classList.add('readonly')
    const table = el('table', 'vgrid')
    wrap.appendChild(table)

    // Columns share the width evenly: GFM has nowhere to keep a width.
    const colgroup = el('colgroup')
    colgroup.appendChild(el('col', 'vgrid-handlecol'))
    for (let c = 0; c < t.colCount; c++) colgroup.appendChild(el('col'))
    table.appendChild(colgroup)

    const clearSelection = () => {
      table.querySelectorAll('.selected').forEach((n) => n.classList.remove('selected'))
      wrap.querySelectorAll('.vgrid-handle.on').forEach((n) => n.classList.remove('on'))
      wrap.classList.remove('sel-all', 'pinned')
    }
    const select = (kind, i, handle) => {
      clearSelection()
      if (kind === 'all') wrap.classList.add('sel-all')
      const cells =
        kind === 'col'
          ? table.querySelectorAll(`.vgrid-cell[data-c="${i}"]`)
          : kind === 'row'
            ? table.querySelectorAll(`tr[data-r="${i}"] .vgrid-cell`)
            : []
      cells.forEach((n) => n.classList.add('selected'))
      handle.classList.add('on')
      wrap.classList.add('pinned')
    }
    const makeHandle = (className, title) => {
      const handle = el('div', 'vgrid-handle')
      handle.title = title
      handle.setAttribute('aria-label', title)
      handle.setAttribute('role', 'button')
      handle.dataset.handle = className
      return handle
    }

    // The handle row: a corner, then one handle per column.
    const handleRow = el('tr', 'vgrid-handles')
    const corner = el('th', 'vgrid-corner')
    handleRow.appendChild(corner)
    if (editable) {
      const cornerHandle = makeHandle('table', 'Table options')
      corner.appendChild(cornerHandle)
      cornerHandle.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        select('all', 0, cornerHandle)
        openMenu(
          cornerHandle,
          'Table',
          [{ label: 'Delete table', danger: true, act: () => runTableCommand(view, wrap, 'tableDelete', 0, 0) }],
          clearSelection
        )
      })
    }
    const colHeads = []
    for (let c = 0; c < t.colCount; c++) {
      const th = el('th', 'vgrid-colh')
      handleRow.appendChild(th)
      colHeads.push(th)
      if (!editable) continue
      const handle = makeHandle('column', `Column ${c + 1} options — drag to move`)
      th.appendChild(handle)
      handlePointer(handle, {
        hit: (x) => {
          const i = colHeads.findIndex((h) => {
            const r = h.getBoundingClientRect()
            return x >= r.left && x < r.right
          })
          return i === -1 ? null : i
        },
        mark: (i) => colHeads.forEach((h, j) => h.classList.toggle('drop', j === i)),
        drop: (i) => runTableCommand(view, wrap, 'tableMoveColumn', 0, c, { fromIndex: c, toIndex: i }),
        pick: () => {
          select('col', c, handle)
          openMenu(
            handle,
            'Column',
            [
              { label: 'Insert column left', act: () => runTableCommand(view, wrap, 'tableAddColumnLeft', 0, c) },
              { label: 'Insert column right', act: () => runTableCommand(view, wrap, 'tableAddColumnRight', 0, c) },
              {
                label: `Cycle alignment (now ${ALIGN_LABEL[t.alignments[c]]})`,
                act: () => runTableCommand(view, wrap, 'tableCycleAlignment', 0, c),
              },
              '-',
              { label: 'Delete column', danger: true, act: () => runTableCommand(view, wrap, 'tableDeleteColumn', 0, c) },
            ],
            clearSelection
          )
        },
      })
    }
    table.appendChild(handleRow)

    const rows = []
    t.segs.forEach((segs, r) => {
      if (r === t.delimIndex) return
      const header = r < t.delimIndex
      const tr = el('tr', header ? 'vgrid-header' : 'vgrid-body')
      tr.dataset.r = String(r)
      rows[r] = tr
      const rowHead = el('td', 'vgrid-rowh')
      tr.appendChild(rowHead)
      if (editable) {
        const handle = makeHandle('row', header ? 'Header row options' : `Row ${r - t.delimIndex} options — drag to move`)
        rowHead.appendChild(handle)
        handlePointer(handle, {
          hit: (_x, y) => {
            const i = rows.findIndex((row, j) => {
              if (!row || j <= t.delimIndex) return false
              const rect = row.getBoundingClientRect()
              return y >= rect.top && y < rect.bottom
            })
            return i === -1 ? null : i
          },
          mark: (i) => rows.forEach((row, j) => row?.querySelector('.vgrid-rowh').classList.toggle('drop', j === i)),
          // The header row stays put: no drop, so a drag is never a drag.
          drop: header ? null : (i) => runTableCommand(view, wrap, 'tableMoveRow', r, 0, { fromIndex: r, toIndex: i }),
          pick: () => {
            select('row', r, handle)
            openMenu(
              handle,
              'Row',
              [
                ...(header ? [] : [{ label: 'Insert row above', act: () => runTableCommand(view, wrap, 'tableAddRowAbove', r, 0) }]),
                { label: 'Insert row below', act: () => runTableCommand(view, wrap, 'tableAddRowBelow', r, 0) },
                '-',
                {
                  label: header ? 'Delete header row (the next row becomes the header)' : 'Delete row',
                  danger: true,
                  act: () => runTableCommand(view, wrap, 'tableDeleteRow', r, 0),
                },
              ],
              clearSelection
            )
          },
        })
      }

      segs.forEach((seg, c) => {
        const cell = el(header ? 'th' : 'td', 'vgrid-cell')
        cell.dataset.c = String(c)
        cell.style.textAlign = t.alignments[c]
        const body = el('div', 'vgrid-text', tableCellText(seg))
        body.dataset.row = String(r)
        body.dataset.col = String(c)
        if (editable) {
          body.contentEditable = 'plaintext-only'
          body.spellcheck = true
          body.addEventListener('focus', () => {
            const index = tableIndexOf(view, wrap)
            if (index !== -1) activeCells.set(view, { index, row: r, col: c })
          })
          body.addEventListener('input', (e) => {
            e.stopPropagation()
            writeCell(view, wrap, r, c, body.textContent)
          })
          body.addEventListener('keydown', (e) => onCellKey(e, view, wrap, r, c))
          // The editor listens for these on its own content; inside a cell they
          // belong to the cell (a paste lands as the cell's text, a copy takes
          // the cell's selection).
          for (const type of CELL_OWNED_EVENTS) body.addEventListener(type, (e) => e.stopPropagation())
          // The cell is the target, not the text run: a press on its padding
          // (or on an empty cell) edits it with the caret at the end.
          cell.addEventListener('mousedown', (e) => {
            if (body.contains(e.target)) return
            e.preventDefault()
            focusCell(body)
          })
        }
        cell.appendChild(body)
        tr.appendChild(cell)
      })
      table.appendChild(tr)
    })

    if (editable) {
      // Hovering near an edge reveals its handles; an open menu pins them.
      const EDGE = 48
      wrap.addEventListener('mousemove', (e) => {
        if (wrap.classList.contains('pinned')) return
        const rect = wrap.getBoundingClientRect()
        wrap.classList.toggle('show-cols', e.clientY - rect.top < EDGE)
        wrap.classList.toggle('show-rows', e.clientX - rect.left < EDGE)
      })
      wrap.addEventListener('mouseleave', () => {
        if (!wrap.classList.contains('pinned')) wrap.classList.remove('show-cols', 'show-rows')
      })
    }
    return wrap
  }
}

// ---------- images and diagrams ----------

class ImageWidget extends WidgetType {
  constructor(source, generation) {
    super()
    this.source = source
    this.generation = generation
  }

  eq(other) {
    return other.source === this.source && other.generation === this.generation
  }

  ignoreEvent() {
    return true
  }

  toDOM(view) {
    const node = el('span', 'cm-visual-image md-rendered')
    const render = view.state.facet(visualConfig).renderMarkdown
    if (render) render(node, this.source)
    else node.textContent = this.source
    return node
  }
}

class MermaidWidget extends WidgetType {
  constructor(source, bodyFrom, bodyTo, canEdit, generation) {
    super()
    this.source = source
    // Offsets of the diagram text inside the fence, relative to its start.
    this.bodyFrom = bodyFrom
    this.bodyTo = bodyTo
    this.canEdit = canEdit
    this.generation = generation
  }

  eq(other) {
    return other.source === this.source && other.canEdit === this.canEdit && other.generation === this.generation
  }

  ignoreEvent() {
    return true
  }

  toDOM(view) {
    const node = el('div', 'cm-visual-mermaid')
    const drawing = el('div', 'cm-visual-mermaid-drawing md-rendered')
    node.appendChild(drawing)
    const render = view.state.facet(visualConfig).renderMarkdown
    if (render) render(drawing, this.source)
    else drawing.textContent = this.source
    if (this.canEdit) {
      const button = el('button', 'btn small', 'Edit diagram text')
      button.type = 'button'
      button.addEventListener('mousedown', (e) => e.preventDefault())
      button.addEventListener('click', () => this.openEditor(view, node, button))
      node.appendChild(button)
    }
    return node
  }

  openEditor(view, node, anchor) {
    document.querySelector('.vgrid-popover')?.remove()
    closeMenu()
    ensureDocumentListeners()
    const rect = anchor.getBoundingClientRect()
    const pop = el('div', 'vgrid-popover')
    pop.setAttribute('role', 'dialog')
    pop.setAttribute('aria-label', 'Diagram text')
    pop.style.top = Math.max(Math.min(rect.bottom + 6, window.innerHeight - 260), 0) + 'px'
    pop.style.left = Math.max(Math.min(rect.left, window.innerWidth - 460), 0) + 'px'
    const textarea = el('textarea')
    textarea.value = this.source.slice(this.bodyFrom, this.bodyTo)
    textarea.spellcheck = false
    const actions = el('div', 'vgrid-popover-actions')
    const cancel = el('button', 'btn small', 'Cancel')
    cancel.type = 'button'
    cancel.addEventListener('click', () => pop.remove())
    const save = el('button', 'btn small primary', 'Apply')
    save.type = 'button'
    save.addEventListener('click', () => {
      const start = widgetPos(view, node)
      pop.remove()
      if (start < 0 || view.state.doc.sliceString(start, start + this.source.length) !== this.source) return
      view.dispatch({
        changes: { from: start + this.bodyFrom, to: start + this.bodyTo, insert: textarea.value },
        userEvent: 'input',
        annotations: isolateHistory.of('full'),
      })
    })
    actions.append(cancel, save)
    pop.append(textarea, actions)
    overlayParent().appendChild(pop)
    textarea.focus()
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true
  }
  toDOM() {
    const rule = document.createElement('span')
    rule.className = 'cm-visual-hr'
    rule.setAttribute('role', 'separator')
    return rule
  }
}

// ---------- the decoration set: what Visual view is ----------

function buildVisual(state, generation) {
  const text = state.doc.toString()
  const editable = state.facet(EditorView.editable)
  const head = state.selection.main.head
  const caretLine = state.doc.lineAt(head)
  const ranges = codeRanges(state)
  const tables = visualTables(state, ranges)
  const inTable = (from, to) => tables.some((t) => from >= t.start && to <= t.end)
  const replaces = []
  const marks = []

  for (const t of tables) {
    const widget = new TableGridWidget(text.slice(t.start, t.end), editable)
    replaces.push({ from: t.start, to: t.end, value: Decoration.replace({ widget, block: true }) })
  }

  // Markers stay visible on the caret's own line, so the markdown under the
  // caret can always be seen and corrected.
  const hide = (from, to) => {
    if (from >= to || inTable(from, to)) return
    if (from >= caretLine.from && to <= caretLine.to) return
    replaces.push({ from, to, value: Decoration.replace({}) })
  }
  const style = (from, to, className) => {
    if (from >= to || inTable(from, to)) return
    marks.push(Decoration.mark({ class: className }).range(from, to))
  }

  syntaxTree(state).iterate({
    enter(node) {
      const { name, from, to } = node
      if (inTable(from, to)) return false
      const heading = /^ATXHeading(\d)$/.exec(name)
      if (heading) {
        style(from, to, `cm-vh cm-vh${heading[1]}`)
        return undefined
      }
      switch (name) {
        case 'HeaderMark': {
          if (!node.node.parent?.name.startsWith('ATXHeading')) return undefined
          const line = state.doc.lineAt(from)
          hide(from, Math.min(to + 1, line.to))
          return undefined
        }
        case 'StrongEmphasis':
          style(from, to, 'cm-vstrong')
          return undefined
        case 'Emphasis':
          style(from, to, 'cm-vem')
          return undefined
        case 'InlineCode':
          style(from, to, 'cm-vcode')
          return undefined
        case 'Link':
          style(from, to, 'cm-vlink')
          return undefined
        case 'Blockquote':
          style(from, to, 'cm-vquote')
          return undefined
        case 'EmphasisMark':
        case 'LinkMark':
        case 'URL':
        case 'LinkTitle':
          if (name === 'EmphasisMark' || node.node.parent?.name === 'Link') hide(from, to)
          return undefined
        case 'CodeMark':
          if (node.node.parent?.name === 'InlineCode') hide(from, to)
          return undefined
        case 'HorizontalRule': {
          // Shown as a rule off the caret's line; `---` is still typed and edited as text.
          const line = state.doc.lineAt(from)
          if (line.number !== caretLine.number) {
            replaces.push({ from, to, value: Decoration.replace({ widget: new RuleWidget() }) })
          }
          return false
        }
        case 'QuoteMark': {
          const after = state.doc.sliceString(to, to + 1) === ' ' ? to + 1 : to
          hide(from, after)
          return undefined
        }
        case 'Image': {
          if (/^!\[[^\]]*\]\([^)]*\)$/.test(text.slice(from, to))) {
            replaces.push({ from, to, value: Decoration.replace({ widget: new ImageWidget(text.slice(from, to), generation) }) })
          }
          return false
        }
        case 'FencedCode': {
          const raw = text.slice(from, to)
          const firstBreak = raw.indexOf('\n')
          if (/^(```|~~~)\s*mermaid\s*$/.test(firstBreak === -1 ? raw : raw.slice(0, firstBreak)) && firstBreak !== -1) {
            const closing = /\n(```|~~~)\s*$/.exec(raw)
            const bodyFrom = firstBreak + 1
            const bodyTo = closing ? Math.max(closing.index, bodyFrom) : raw.length
            const widget = new MermaidWidget(raw, bodyFrom, bodyTo, editable, generation)
            replaces.push({ from, to, value: Decoration.replace({ widget, block: true }) })
          } else {
            for (let pos = from; pos <= to; ) {
              const line = state.doc.lineAt(pos)
              marks.push(Decoration.line({ class: 'cm-vcodeblock' }).range(line.from))
              pos = line.to + 1
            }
          }
          return false
        }
        default:
          return undefined
      }
    },
  })

  // Replaced ranges may not overlap one another; marks nest freely (bold went
  // missing in the prototype until the two were kept apart).
  replaces.sort((a, b) => a.from - b.from || a.to - b.to)
  const kept = []
  let lastTo = -1
  for (const d of replaces) {
    if (d.from < lastTo) continue
    kept.push(d.value.range(d.from, d.to))
    lastTo = Math.max(lastTo, d.to)
  }
  return {
    generation,
    // Only replaced ranges are atomic: the caret steps over a widget or a
    // hidden marker, but walks freely through bold or linked text.
    atomic: Decoration.set(kept, true),
    decorations: Decoration.set([...kept, ...marks], true),
  }
}

const visualField = StateField.define({
  create: (state) => buildVisual(state, 0),
  update(value, tr) {
    const refresh = tr.effects.some((e) => e.is(refreshVisual))
    const generation = refresh ? value.generation + 1 : value.generation
    if (tr.annotation(fromCell) && !refresh) {
      return { generation, atomic: value.atomic.map(tr.changes), decorations: value.decorations.map(tr.changes) }
    }
    if (
      refresh ||
      tr.docChanged ||
      tr.selection ||
      syntaxTree(tr.startState) !== syntaxTree(tr.state) ||
      tr.startState.facet(EditorView.editable) !== tr.state.facet(EditorView.editable)
    ) {
      return buildVisual(tr.state, generation)
    }
    return value
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(field, false)?.atomic ?? Decoration.none),
  ],
})

// The Visual layer, ready to drop into a compartment.
export function visualMode({ renderMarkdown, historyView } = {}) {
  return [
    visualConfig.of({ renderMarkdown, historyView }),
    visualField,
    EditorView.lineWrapping,
    EditorView.editorAttributes.of({ class: 'cm-visual' }),
    // Focus landing on the text itself (not a grid cell) ends cell editing.
    EditorView.domEventHandlers({
      focus: (e, view) => {
        if (e.target === view.contentDOM) clearActiveCell(view)
        return false
      },
      mousedown: (e, view) => {
        if (!e.target.closest?.('.vgrid-wrap')) clearActiveCell(view)
        return false
      },
    }),
  ]
}
