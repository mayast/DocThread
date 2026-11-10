import type { SourceTarget } from './source.ts';
import type { MentionReference, Thread } from './types.ts';
import { extractMentions, normalizeIdentity } from './review.ts';

/**
 * Which mention form a provider expects.
 *
 * GitHub notifies via a repository issue comment, so it needs the exact GitHub
 * login — on EMU that is `alias_tenant` (e.g. `mayast_microsoft`).
 * Azure DevOps notifies the Microsoft identity, which is the bare alias.
 *
 * Getting this wrong is silent: the comment saves, the mention renders, and
 * nobody is notified. That is why the picker inserts the form rather than
 * asking the reviewer to remember which context they are in.
 */
export type MentionStyle = 'github-login' | 'ado-alias';

export function mentionStyleFor(target: SourceTarget | null): MentionStyle {
  return target?.kind === 'ado-workitem' || target?.kind === 'azure-repos'
    ? 'ado-alias'
    : 'github-login';
}

/** Human label for the style, used in the composer hint. */
export function mentionStyleHint(style: MentionStyle): string {
  return style === 'ado-alias'
    ? 'Azure DevOps notifies the Microsoft alias, e.g. @alias'
    : 'GitHub notifies the account login, e.g. @alias_tenant';
}

export interface MentionCandidate {
  /** The exact text inserted after '@'. */
  value: string;
  /** Where this candidate came from, shown as secondary text. */
  source: 'you' | 'participant';
}

/**
 * Convert an identity into the form the current provider expects.
 * EMU logins carry an `_tenant` suffix; ADO wants it stripped, GitHub wants it
 * kept. When the input has no suffix there is nothing to convert either way.
 */
export function toMentionForm(identity: string, style: MentionStyle): string {
  const bare = normalizeIdentity(identity);
  if (!bare) return '';
  if (style === 'ado-alias') {
    // Reduce to the bare Microsoft alias by stripping an EMU `_tenant` suffix
    // and/or an email domain, e.g. `mayast_microsoft` -> `mayast` and
    // `mayast@microsoft.com` -> `mayast`.
    const cut = bare.search(/[_@]/);
    return cut > 0 ? bare.slice(0, cut) : bare;
  }
  return bare;
}

/**
 * Candidate list for the picker: the signed-in user first, then everyone who
 * has already commented on or been mentioned in this document.
 *
 * Deliberately NOT a directory lookup. Review participants are the people you
 * actually want to notify, they need no extra permission to enumerate, and it
 * keeps the picker useful offline and on the built-in sample.
 */
export function mentionCandidates(
  threads: Thread[],
  viewer: string,
  style: MentionStyle
): MentionCandidate[] {
  const seen = new Set<string>();
  const out: MentionCandidate[] = [];

  const add = (raw: string, source: MentionCandidate['source']) => {
    const value = toMentionForm(raw, style);
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ value, source });
  };

  add(viewer, 'you');
  for (const thread of threads) {
    for (const comment of thread.comments) {
      add(comment.authorLogin || comment.author, 'participant');
      if (comment.identityVersion === 1 && comment.mentions) {
        for (const mention of comment.mentions) add(mention.handle, 'participant');
      } else {
        for (const mentioned of extractMentions(comment.body)) add(mentioned, 'participant');
      }
    }
  }
  return out;
}

export interface MentionQuery {
  /** Index of the '@' that opened this mention. */
  start: number;
  /** Text typed after the '@' so far. */
  term: string;
}

/**
 * Detect an in-progress mention immediately before the caret.
 * Returns null when the caret is not inside a mention, so the picker stays
 * closed during ordinary typing.
 */
export function activeMentionQuery(text: string, caret: number): MentionQuery | null {
  const start = text.lastIndexOf('@', caret - 1);
  if (start < 0 || start !== caret - 1) return null;
  const before = start === 0 ? '' : text[start - 1];
  if (before && /[\p{L}\p{N}_.@-]/u.test(before)) return null;
  return { start, term: '' };
}

export function updateMentionQuery(
  text: string,
  caret: number,
  current: MentionQuery | null
): MentionQuery | null {
  if (!current) return activeMentionQuery(text, caret);
  if (current.start < 0 || text[current.start] !== '@' || caret <= current.start) return null;
  const term = text.slice(current.start + 1, caret);
  if (term.includes('\n') || term.includes('\r') || term.length > 80) return null;
  return { start: current.start, term };
}

function commonPrefix(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

function commonSuffix(left: string, right: string, prefix: number): number {
  let count = 0;
  while (
    count < left.length - prefix &&
    count < right.length - prefix &&
    left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1;
  }
  return count;
}

export function reconcileMentionReferences(
  previousText: string,
  nextText: string,
  mentions: MentionReference[]
): MentionReference[] {
  if (previousText === nextText) return mentions;
  const prefix = commonPrefix(previousText, nextText);
  const suffix = commonSuffix(previousText, nextText, prefix);
  const previousEditEnd = previousText.length - suffix;
  const nextEditEnd = nextText.length - suffix;
  const delta = nextEditEnd - previousEditEnd;

  const reconciled: MentionReference[] = [];
  for (const mention of mentions) {
    const mentionEnd = mention.start + mention.length;
    let start = mention.start;
    if (previousEditEnd <= mention.start) start += delta;
    else if (prefix < mentionEnd) continue;
    if (nextText.slice(start, start + mention.length) !== mention.text) continue;
    reconciled.push({ ...mention, start });
  }
  return reconciled;
}

const UNRESOLVED_MENTION_RE =
  /(^|[^a-z\d_.@-])@([a-z\d](?:[a-z\d_]|-(?=[a-z\d_])){0,38})(?![a-z\d_-])/gi;

export function includeUnresolvedMentionReferences(
  body: string,
  mentions: readonly MentionReference[]
): MentionReference[] {
  const result = [...mentions];
  UNRESOLVED_MENTION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = UNRESOLVED_MENTION_RE.exec(body)) !== null) {
    const start = match.index + match[1].length;
    const text = `@${match[2]}`;
    const end = start + text.length;
    if (
      result.some(
        (mention) => mention.start < end && mention.start + mention.length > start
      )
    ) {
      continue;
    }
    result.push({
      kind: 'unresolved',
      start,
      length: text.length,
      text,
      handle: match[2],
    });
  }
  return result.sort((left, right) => left.start - right.start || left.length - right.length);
}

export function finalizeMentionReferences(
  body: string,
  mentions: readonly MentionReference[]
): MentionReference[] {
  const matching = mentions.filter(
    (mention) =>
      mention.start >= 0 &&
      mention.start + mention.length <= body.length &&
      body.slice(mention.start, mention.start + mention.length) === mention.text
  );
  return includeUnresolvedMentionReferences(body, matching);
}

export function filterCandidates(
  candidates: MentionCandidate[],
  term: string,
  limit = 6
): MentionCandidate[] {
  const needle = term.trim().toLowerCase();
  const matches = needle
    ? candidates.filter((candidate) => candidate.value.toLowerCase().includes(needle))
    : candidates;
  return matches.slice(0, limit);
}

/** Replace the in-progress mention with the chosen value, leaving a trailing space. */
export function applyMention(
  text: string,
  query: MentionQuery,
  caret: number,
  value: string
): { text: string; caret: number } {
  const next = `${text.slice(0, query.start)}@${value} ${text.slice(caret)}`;
  return { text: next, caret: query.start + value.length + 2 };
}
