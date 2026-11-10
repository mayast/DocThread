// Pure helpers for "deep-link to a specific review thread" (#32).
//
// A DocThread deep link already encodes which document to open (the canonical
// GitHub target, or ?source/?doc for other providers). To also focus a single
// review thread we carry its id in a `thread` query parameter. These helpers
// are intentionally dependency-free so they can be unit-tested under node --test.

export const THREAD_PARAM = 'thread';

/**
 * Append (or replace) the `thread` query parameter on an existing DocThread
 * deep-link URL. All other parameters are preserved.
 */
export function withThreadParam(deepLinkUrl: string, threadId: string): string {
  const url = new URL(deepLinkUrl);
  url.searchParams.set(THREAD_PARAM, threadId);
  return url.toString();
}

/**
 * Read the deep-linked thread id from a URL search string
 * (e.g. `window.location.search`). Returns null when the parameter is absent or
 * blank so callers can cleanly fall back to loading the document normally.
 */
export function readThreadParam(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get(THREAD_PARAM);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}
