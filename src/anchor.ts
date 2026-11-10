// The anchor engine — the heart of DocThread.
//
// Problem: line/character offsets break the moment someone edits the document above
// an anchor. So we anchor to the *text itself* (a quote) plus a window of surrounding
// context, and re-locate it with fuzzy matching (diff-match-patch) on every render.
//
// This is the same strategy used by Hypothesis / apache-annotator.

import { diff_match_patch } from 'diff-match-patch';
import type { Anchor, AnchorConfidence } from './types';

const CONTEXT = 32; // chars of prefix/suffix context to store
const BITAP_MAX = 32; // diff-match-patch bitap pattern limit
const MIN_FUZZY_SIMILARITY = 0.6; // reject unverifiable long-quote matches

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'TD',
  'TH',
  'TR',
  'TABLE',
  'BLOCKQUOTE',
  'PRE',
  'SECTION',
  'ARTICLE',
  'HR',
  'BR',
]);

function nearestBlock(n: Node, root: HTMLElement): Element | null {
  let p: Node | null = n.parentNode;
  while (p && p !== root) {
    if (p instanceof HTMLElement && BLOCK_TAGS.has(p.tagName)) return p;
    p = p.parentNode;
  }
  return root;
}

// ---------------------------------------------------------------------------
// Plain-text projection of the rendered DOM, with a map back to DOM positions.
// ---------------------------------------------------------------------------

interface TextMap {
  text: string;
  // For each text node: its starting offset in `text` and the node itself.
  nodes: { node: Text; start: number }[];
}

/** Walk the rendered root and build a plain-text string + offset map to text nodes. */
export function buildTextMap(root: HTMLElement): TextMap {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let text = '';
  const nodes: { node: Text; start: number }[] = [];
  let lastBlock: Element | null = null;
  let n = walker.nextNode() as Text | null;
  while (n) {
    // Skip text inside the comment gutter/UI (marked with data-docthread-ui).
    let skip = false;
    let p: Node | null = n.parentNode;
    while (p && p !== root) {
      if (p instanceof HTMLElement && p.hasAttribute('data-docthread-ui')) {
        skip = true;
        break;
      }
      p = p.parentNode;
    }
    if (!skip) {
      const block = nearestBlock(n, root);
      if (lastBlock && block !== lastBlock && text.length > 0) text += '\n';
      lastBlock = block;
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    n = walker.nextNode() as Text | null;
  }
  return { text, nodes };
}

/** Convert a global text offset into a concrete {node, offset} DOM position. */
function offsetToDom(map: TextMap, offset: number): { node: Text; offset: number } | null {
  for (let i = 0; i < map.nodes.length; i++) {
    const cur = map.nodes[i];
    const end = cur.start + cur.node.data.length;
    if (offset <= end) {
      return { node: cur.node, offset: Math.max(0, offset - cur.start) };
    }
  }
  const last = map.nodes[map.nodes.length - 1];
  return last ? { node: last.node, offset: last.node.data.length } : null;
}

// ---------------------------------------------------------------------------
// Create an anchor from a live user selection.
// ---------------------------------------------------------------------------

export function createAnchor(root: HTMLElement, range: Range): Anchor | null {
  const map = buildTextMap(root);
  const start = domToOffset(map, range.startContainer, range.startOffset);
  const end = domToOffset(map, range.endContainer, range.endOffset);
  if (start == null || end == null || end <= start) return null;

  const quote = map.text.slice(start, end);
  const prefix = map.text.slice(Math.max(0, start - CONTEXT), start);
  const suffix = map.text.slice(end, Math.min(map.text.length, end + CONTEXT));
  return { quote, prefix, suffix, start };
}

function domToOffset(map: TextMap, container: Node, offset: number): number | null {
  // If the container is an element, resolve to the appropriate text node.
  if (container.nodeType === Node.ELEMENT_NODE) {
    const el = container as Element;
    const child = el.childNodes[offset] ?? el.childNodes[offset - 1];
    if (child && child.nodeType === Node.TEXT_NODE) {
      container = child;
      offset = child === el.childNodes[offset] ? 0 : (child as Text).data.length;
    } else {
      // Find first text node descendant.
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const t = w.nextNode() as Text | null;
      if (!t) return null;
      container = t;
      offset = 0;
    }
  }
  for (const entry of map.nodes) {
    if (entry.node === container) return entry.start + offset;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Locate an anchor in the (possibly edited) current document.
// ---------------------------------------------------------------------------

export interface Located {
  range: Range;
  startOffset: number;
  endOffset: number;
  /** Retained for existing callers: true for exact | high | medium. */
  exact: boolean;
  confidence: AnchorConfidence;
}

export function locateAnchor(root: HTMLElement, anchor: Anchor): Located | null {
  const map = buildTextMap(root);
  const found = findQuote(map.text, anchor);
  if (!found) return null;

  const startDom = offsetToDom(map, found.start);
  const endDom = offsetToDom(map, found.end);
  if (!startDom || !endDom) return null;

  const range = document.createRange();
  try {
    range.setStart(startDom.node, startDom.offset);
    range.setEnd(endDom.node, endDom.offset);
  } catch {
    return null;
  }
  return {
    range,
    startOffset: found.start,
    endOffset: found.end,
    exact: found.exact,
    confidence: found.confidence,
  };
}

/** Multi-strategy search: exact context match → exact quote → fuzzy quote. */
function findQuote(
  text: string,
  anchor: Anchor
): { start: number; end: number; exact: boolean; confidence: AnchorConfidence } | null {
  const { quote, prefix, suffix } = anchor;
  if (!quote) return null;

  const ok = (start: number, confidence: AnchorConfidence, end?: number) => ({
    start,
    end: end ?? start + quote.length,
    exact: confidence === 'exact' || confidence === 'high' || confidence === 'medium',
    confidence,
  });

  // 1. Exact match of prefix + quote + suffix. Unambiguous by construction.
  const withContext = prefix + quote + suffix;
  const ctxIdx = text.indexOf(withContext);
  if (ctxIdx !== -1) return ok(ctxIdx + prefix.length, 'exact');

  // 2. Exact quote matches. Count them before choosing one.
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(quote, from);
    if (at === -1) break;
    positions.push(at);
    from = at + 1;
    if (positions.length > 50) break;
  }

  if (positions.length === 1) return ok(positions[0], 'high');

  if (positions.length > 1) {
    // Stored context can disambiguate repeats without silently trusting proximity.
    const scored = positions.map((p) => {
      const before = text.slice(Math.max(0, p - prefix.length), p);
      const after = text.slice(p + quote.length, p + quote.length + suffix.length);
      let score = 0;
      if (prefix && before === prefix) score += 2;
      if (suffix && after === suffix) score += 2;
      if (prefix && !score && before.endsWith(prefix.slice(-8))) score += 1;
      if (suffix && after.startsWith(suffix.slice(0, 8))) score += 1;
      return { p, score };
    });
    const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
    const tied = scored.filter((s) => s.score === best.score).length > 1;

    if (best.score >= 2 && !tied) return ok(best.p, 'medium');

    // Keep the comment visible at the nearest occurrence, but flag the ambiguity.
    const nearest = positions
      .slice()
      .sort((a, b) => Math.abs(a - anchor.start) - Math.abs(b - anchor.start))[0];
    return ok(nearest, 'needs-confirmation');
  }

  // 3. Fuzzy. The quote no longer appears verbatim.
  try {
    const dmp = new diff_match_patch();
    dmp.Match_Threshold = 0.5;
    dmp.Match_Distance = 1000;
    const loc = Math.min(anchor.start, Math.max(0, text.length - 1));

    if (quote.length <= BITAP_MAX) {
      const hit = dmp.match_main(text, quote, loc);
      if (hit !== -1) {
        return ok(hit, 'needs-confirmation', Math.min(text.length, hit + quote.length));
      }
      return null;
    }

    if (quote.length > 5000) return null;

    // Bitap can locate only the first 32 characters of a long quote. Verify the
    // full candidate before returning a range rather than assuming its length.
    const head = dmp.match_main(text, quote.slice(0, BITAP_MAX), loc);
    if (head === -1) return null;

    const candidate = text.slice(head, Math.min(text.length, head + quote.length));
    if (similarity(dmp, quote, candidate) < MIN_FUZZY_SIMILARITY) return null;

    return ok(head, 'needs-confirmation', head + candidate.length);
  } catch {
    return null;
  }
}

/** 0..1 similarity between two strings, via diff-match-patch edit distance. */
function similarity(dmp: InstanceType<typeof diff_match_patch>, a: string, b: string): number {
  if (!a.length && !b.length) return 1;
  const diffs = dmp.diff_main(a, b);
  const distance = dmp.diff_levenshtein(diffs);
  return 1 - distance / Math.max(a.length, b.length);
}

/**
 * Locate an anchor inside an arbitrary plain-text string (e.g. the raw Markdown
 * source shown in the Edit view). Same multi-strategy search used for the DOM.
 */
export function locateInText(
  text: string,
  anchor: Anchor
): { start: number; end: number; exact: boolean; confidence: AnchorConfidence } | null {
  return findQuote(text, anchor);
}
