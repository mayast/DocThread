// Editor preferences (#62).
//
// Currently just the spell-check toggle for the in-place Markdown editor. Native
// browser spell-checking is enabled by default; authors editing code-heavy docs
// can turn it off so fenced/inline code doesn't produce a red-squiggle storm
// (best-effort scoping — a plain <textarea> can't exclude code regions itself).
//
// Pure + localStorage-guarded so it stays unit-testable and safe to import
// anywhere (no-ops when storage is unavailable).

export const SPELLCHECK_KEY = 'docthread:spellcheck';

/** Parse a stored spell-check pref. Anything but the explicit "0" (off) is on,
 *  so the default — and any malformed value — keeps spell-checking enabled. */
export function parseSpellCheckPref(raw: string | null | undefined): boolean {
  return raw !== '0';
}

/** Serialize the pref: "1" (on) / "0" (off). */
export function serializeSpellCheckPref(on: boolean): string {
  return on ? '1' : '0';
}

export function loadSpellCheckPref(): boolean {
  if (typeof localStorage === 'undefined') return true;
  try {
    return parseSpellCheckPref(localStorage.getItem(SPELLCHECK_KEY));
  } catch {
    return true;
  }
}

export function storeSpellCheckPref(on: boolean): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(SPELLCHECK_KEY, serializeSpellCheckPref(on));
  } catch {
    /* ignore quota/serialization errors — this is a convenience pref only */
  }
}

// ---- Edit-mode view (#38): Editor / Split / Preview ----

export type EditorViewMode = 'editor' | 'split' | 'preview';
export const EDITOR_VIEW_KEY = 'docthread:editor-view';
const EDITOR_VIEW_MODES: readonly EditorViewMode[] = ['editor', 'split', 'preview'];

/** Parse a stored edit-view mode; anything unrecognized falls back to 'editor'
 *  (the historical default — editor only, no preview). */
export function parseEditorViewMode(raw: string | null | undefined): EditorViewMode {
  return EDITOR_VIEW_MODES.includes(raw as EditorViewMode) ? (raw as EditorViewMode) : 'editor';
}

export function loadEditorViewMode(): EditorViewMode {
  if (typeof localStorage === 'undefined') return 'editor';
  try {
    return parseEditorViewMode(localStorage.getItem(EDITOR_VIEW_KEY));
  } catch {
    return 'editor';
  }
}

export function storeEditorViewMode(mode: EditorViewMode): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(EDITOR_VIEW_KEY, mode);
  } catch {
    /* ignore quota/serialization errors — this is a convenience pref only */
  }
}
