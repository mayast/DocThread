// Recently viewed documents — a small, local-only list of sources the user has
// successfully loaded, surfaced in a collapsible left panel for one-click return.
//
// This module is intentionally free of DOM/React and Vite-only globals so the
// list logic (parse / promote / cap) stays deterministic and unit-testable under
// `node --test`. The thin localStorage wrappers are guarded so they are safe to
// import anywhere and simply no-op when storage is unavailable.

/** One entry in the recently-viewed list. Stores only what is needed to rebuild
 * the load and render a label — never document content or review data. */
export interface RecentEntry {
  /** Canonical source identity (the same key used for review storage). Dedupe key. */
  key: string;
  /** Canonical source URL used to reload the document via the normal load path. */
  url: string;
  /** Provider kind: 'github' | 'azure-repos' | 'ado-workitem'. */
  kind: string;
  /** Repository / project label for display. */
  repoLabel: string;
  /** Document / file / work-item label for display. */
  docLabel: string;
  /** Optional ref label (branch/tag/commit); omitted for ADO work items. */
  refLabel?: string;
  /** Last-opened time (epoch ms), used only for ordering/debugging. */
  ts: number;
}

export const RECENTS_STORAGE_KEY = 'docthread:recents';
export const RECENTS_COLLAPSED_KEY = 'docthread:recents:collapsed';
export const RECENTS_LIMIT = 10;

/** Parse a stored recents JSON string into a validated, capped list. Malformed
 * input (or malformed individual entries) is dropped rather than thrown. */
export function parseRecents(raw: string | null | undefined): RecentEntry[] {
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentEntry[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Record<string, unknown>;
    if (typeof e.key !== 'string' || !e.key) continue;
    if (typeof e.url !== 'string' || !e.url) continue;
    if (typeof e.kind !== 'string') continue;
    if (typeof e.repoLabel !== 'string') continue;
    if (typeof e.docLabel !== 'string') continue;
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    const entry: RecentEntry = {
      key: e.key,
      url: e.url,
      kind: e.kind,
      repoLabel: e.repoLabel,
      docLabel: e.docLabel,
      ts: typeof e.ts === 'number' && Number.isFinite(e.ts) ? e.ts : 0,
    };
    if (typeof e.refLabel === 'string' && e.refLabel) entry.refLabel = e.refLabel;
    out.push(entry);
    if (out.length >= RECENTS_LIMIT) break;
  }
  return out;
}

/** Return a new list with `entry` moved to the front, de-duplicated by `key`,
 * and capped at `limit`. Pure — never mutates its input. */
export function promoteRecent(
  list: readonly RecentEntry[],
  entry: RecentEntry,
  limit: number = RECENTS_LIMIT
): RecentEntry[] {
  const deduped = list.filter((existing) => existing.key !== entry.key);
  return [entry, ...deduped].slice(0, Math.max(0, limit));
}

/** Serialize a recents list for storage. */
export function serializeRecents(list: readonly RecentEntry[]): string {
  return JSON.stringify(list);
}

// ---- localStorage wrappers (safe no-ops when storage is unavailable) ----

export function loadRecents(): RecentEntry[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    return parseRecents(localStorage.getItem(RECENTS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function storeRecents(list: readonly RecentEntry[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RECENTS_STORAGE_KEY, serializeRecents(list));
  } catch {
    /* ignore quota/serialization errors — recents are a convenience only */
  }
}

export function loadRecentsCollapsed(defaultValue = false): boolean {
  if (typeof localStorage === 'undefined') return defaultValue;
  try {
    const value = localStorage.getItem(RECENTS_COLLAPSED_KEY);
    return value === null ? defaultValue : value === '1';
  } catch {
    return defaultValue;
  }
}

export function storeRecentsCollapsed(collapsed: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(RECENTS_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch {
    /* ignore */
  }
}
