import { buildTextMap, locateInText } from './anchor.ts';
import type { Anchor } from './types.ts';

export type ApplyHtmlSuggestionResult =
  | { ok: true; html: string; start: number; end: number; confidence: string }
  | { ok: false; reason: 'stale' };

type TextEntry = ReturnType<typeof buildTextMap>['nodes'][number];

function domPosition(
  entries: readonly TextEntry[],
  offset: number,
  bias: 'start' | 'end'
): { node: Text; offset: number } | null {
  let previous: TextEntry | null = null;
  for (const entry of entries) {
    const end = entry.start + entry.node.data.length;
    if (offset >= entry.start && offset <= end) {
      return { node: entry.node, offset: Math.max(0, Math.min(entry.node.data.length, offset - entry.start)) };
    }
    if (offset < entry.start) {
      if (bias === 'start') return { node: entry.node, offset: 0 };
      return previous ? { node: previous.node, offset: previous.node.data.length } : { node: entry.node, offset: 0 };
    }
    previous = entry;
  }
  return previous ? { node: previous.node, offset: previous.node.data.length } : null;
}

function isBetween(entry: TextEntry, start: TextEntry, end: TextEntry): boolean {
  return entry.start > start.start && entry.start < end.start;
}

export function applyHtmlSuggestion(
  html: string,
  anchor: Anchor,
  replacement: string
): ApplyHtmlSuggestionResult {
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  const map = buildTextMap(doc.body);
  const located = locateInText(map.text, anchor);
  if (!located || located.end < located.start) return { ok: false, reason: 'stale' };

  const start = domPosition(map.nodes, located.start, 'start');
  const end = domPosition(map.nodes, located.end, 'end');
  if (!start || !end) return { ok: false, reason: 'stale' };

  if (start.node === end.node) {
    start.node.data =
      start.node.data.slice(0, start.offset) + replacement + start.node.data.slice(end.offset);
  } else {
    const startEntry = map.nodes.find((entry) => entry.node === start.node);
    const endEntry = map.nodes.find((entry) => entry.node === end.node);
    if (!startEntry || !endEntry) return { ok: false, reason: 'stale' };
    start.node.data = start.node.data.slice(0, start.offset) + replacement + end.node.data.slice(end.offset);
    for (const entry of map.nodes) {
      if (entry.node !== start.node && entry.node !== end.node && isBetween(entry, startEntry, endEntry)) {
        entry.node.data = '';
      }
    }
    end.node.data = '';
  }

  return {
    ok: true,
    html: `<!doctype html>${doc.documentElement.outerHTML}`,
    start: located.start,
    end: located.start + replacement.length,
    confidence: located.confidence,
  };
}
