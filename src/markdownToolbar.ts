// ---------------------------------------------------------------------------
// Markdown formatting transforms for the Edit Doc toolbar (#78).
//
// Pure, DOM-free functions that take the current editor text plus a selection
// range and return the new text with an updated selection. The React toolbar
// (in App.tsx) reads the textarea selection, calls one of these, writes the
// result back through the normal `draftMd` onChange path, and restores the
// returned selection. Keeping the logic here (no DOM) makes every transform
// unit-testable and keeps the raw-Markdown source of truth intact, so comment
// anchoring is unaffected.
// ---------------------------------------------------------------------------

export interface Selection {
  /** Full editor text. */
  text: string;
  /** Selection start offset (inclusive). */
  start: number;
  /** Selection end offset (exclusive). */
  end: number;
}

const TASK_LINE = /^- \[[ xX]\] /;
const ORDERED_LINE = /^\d+\.\s/;

function splice(sel: Selection, from: number, to: number, insert: string): string {
  return sel.text.slice(0, from) + insert + sel.text.slice(to);
}

/** Toggle an inline wrapper (e.g. `**`, `*`, `` ` ``) around the selection. */
export function toggleInline(sel: Selection, marker: string): Selection {
  const { text, start, end } = sel;
  const selected = text.slice(start, end);
  const m = marker.length;

  // Case 1: the selection itself already carries the markers — unwrap it.
  if (
    selected.length >= 2 * m &&
    selected.startsWith(marker) &&
    selected.endsWith(marker)
  ) {
    const inner = selected.slice(m, selected.length - m);
    return { text: splice(sel, start, end, inner), start, end: start + inner.length };
  }

  // Case 2: markers sit just outside the selection — strip them.
  if (text.slice(start - m, start) === marker && text.slice(end, end + m) === marker) {
    const next = text.slice(0, start - m) + selected + text.slice(end + m);
    return { text: next, start: start - m, end: end - m };
  }

  // Case 3: wrap. Keep the whole wrapped region (markers included) selected so
  // re-applying the command cleanly toggles it back off.
  const wrapped = marker + selected + marker;
  const next = splice(sel, start, end, wrapped);
  if (start === end) {
    // Empty selection: drop the caret between the markers.
    return { text: next, start: start + m, end: start + m };
  }
  return { text: next, start, end: end + 2 * m };
}

/** Bounds of the full lines spanned by the selection. */
function lineBlock(text: string, start: number, end: number): { from: number; to: number } {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  const nl = text.indexOf('\n', end);
  const to = nl === -1 ? text.length : nl;
  return { from, to };
}

function hasPrefix(line: string, prefix: string): boolean {
  if (prefix.startsWith('- [ ]')) return TASK_LINE.test(line);
  return line.startsWith(prefix);
}

function stripPrefix(line: string, prefix: string): string {
  if (prefix.startsWith('- [ ]')) return line.replace(TASK_LINE, '');
  return line.startsWith(prefix) ? line.slice(prefix.length) : line;
}

/**
 * Toggle a static line prefix (heading `## `, quote `> `, bullet `- `,
 * task `- [ ] `) on every line the selection touches. Adds the prefix unless
 * every non-empty line already has it, in which case it is removed.
 */
export function toggleLinePrefix(sel: Selection, prefix: string): Selection {
  const { text } = sel;
  const { from, to } = lineBlock(text, sel.start, sel.end);
  const lines = text.slice(from, to).split('\n');
  const meaningful = lines.filter((l) => l.trim().length > 0);
  const allPrefixed =
    meaningful.length > 0 && meaningful.every((l) => hasPrefix(l, prefix));

  const next = lines
    .map((line) => {
      if (line.trim().length === 0) return line;
      return allPrefixed ? stripPrefix(line, prefix) : prefix + line;
    })
    .join('\n');

  return {
    text: text.slice(0, from) + next + text.slice(to),
    start: from,
    end: from + next.length,
  };
}

/** Toggle an ordered (numbered) list across the selected lines. */
export function toggleOrderedList(sel: Selection): Selection {
  const { text } = sel;
  const { from, to } = lineBlock(text, sel.start, sel.end);
  const lines = text.slice(from, to).split('\n');
  const meaningful = lines.filter((l) => l.trim().length > 0);
  const allNumbered =
    meaningful.length > 0 && meaningful.every((l) => ORDERED_LINE.test(l));

  let n = 0;
  const next = lines
    .map((line) => {
      if (line.trim().length === 0) return line;
      if (allNumbered) return line.replace(ORDERED_LINE, '');
      n += 1;
      return `${n}. ${line}`;
    })
    .join('\n');

  return {
    text: text.slice(0, from) + next + text.slice(to),
    start: from,
    end: from + next.length,
  };
}

/**
 * Inline `` `code` `` for a non-empty single-line selection; a fenced code
 * block otherwise (multi-line or empty selection).
 */
export function applyCode(sel: Selection): Selection {
  const selected = sel.text.slice(sel.start, sel.end);
  if (selected.length > 0 && !selected.includes('\n')) {
    return toggleInline(sel, '`');
  }
  const block = '```\n' + selected + '\n```';
  const next = splice(sel, sel.start, sel.end, block);
  // Select the code body (between the fences) so typing replaces the placeholder.
  const bodyStart = sel.start + 4; // "```\n"
  return { text: next, start: bodyStart, end: bodyStart + selected.length };
}

function insertBracketed(sel: Selection, bang: string, fallback: string): Selection {
  const label = sel.text.slice(sel.start, sel.end) || fallback;
  const snippet = `${bang}[${label}](url)`;
  const next = splice(sel, sel.start, sel.end, snippet);
  // Leave the selection on the `url` placeholder.
  const urlStart = sel.start + bang.length + 1 + label.length + 2;
  return { text: next, start: urlStart, end: urlStart + 3 };
}

/** Insert a Markdown link, using any selection as the link text. */
export function insertLink(sel: Selection): Selection {
  return insertBracketed(sel, '', 'text');
}

/** Insert a Markdown image, using any selection as the alt text. */
export function insertImage(sel: Selection): Selection {
  return insertBracketed(sel, '!', 'alt');
}

export type ToolbarCommand =
  | 'heading'
  | 'bold'
  | 'italic'
  | 'quote'
  | 'code'
  | 'link'
  | 'ordered-list'
  | 'unordered-list'
  | 'task-list';

/** Apply a named toolbar command to a selection. */
export function applyCommand(command: ToolbarCommand, sel: Selection): Selection {
  switch (command) {
    case 'heading':
      return toggleLinePrefix(sel, '## ');
    case 'bold':
      return toggleInline(sel, '**');
    case 'italic':
      return toggleInline(sel, '*');
    case 'quote':
      return toggleLinePrefix(sel, '> ');
    case 'code':
      return applyCode(sel);
    case 'link':
      return insertLink(sel);
    case 'ordered-list':
      return toggleOrderedList(sel);
    case 'unordered-list':
      return toggleLinePrefix(sel, '- ');
    case 'task-list':
      return toggleLinePrefix(sel, '- [ ] ');
    default:
      return sel;
  }
}
