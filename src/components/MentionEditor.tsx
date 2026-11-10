import {
  type KeyboardEvent as ReactKeyboardEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { SearchCandidate } from '../identity';
import { rememberMentionContact } from '../mentionContacts';
import {
  applyMention,
  filterCandidates,
  reconcileMentionReferences,
  updateMentionQuery,
  type MentionCandidate,
  type MentionQuery,
} from '../mentions';
import type { MentionReference } from '../types';

export type IdentitySearchOutcome =
  | { kind: 'results'; candidates: SearchCandidate[] }
  | { kind: 'needs-signin'; authority: 'github' | 'microsoft' }
  | { kind: 'unavailable' };

interface PickerCandidate {
  id: string;
  value: string;
  displayName: string;
  secondary?: string;
  source: 'you' | 'participant' | 'github' | 'entra';
  externalHint?: 'b2b-guest';
  resolved?: SearchCandidate;
}

interface Props {
  value: string;
  mentions: MentionReference[];
  localCandidates: MentionCandidate[];
  placeholder: string;
  disabled?: boolean;
  autoFocus?: boolean;
  className?: string;
  providerLabel: string;
  search: (term: string, signal: AbortSignal) => Promise<IdentitySearchOutcome>;
  onRequestSignIn: (authority: 'github' | 'microsoft') => Promise<void>;
  onChange: (value: string, mentions: MentionReference[]) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  onClick?: (event: React.MouseEvent<HTMLTextAreaElement>) => void;
}

function resolvedMention(candidate: SearchCandidate, start: number): MentionReference {
  const text = `@${candidate.handle}`;
  // Stash the picked person's email (Graph `mail`/UPN, surfaced via secondaryLabel)
  // so the comment-submit path can email them. Not persisted to the review file.
  rememberMentionContact(
    candidate.subject.subjectKey,
    candidate.secondaryLabel(),
    candidate.subject.displayName
  );
  return {
    kind: 'resolved',
    start,
    length: text.length,
    text,
    subjectKey: candidate.subject.subjectKey,
    identityKeys: candidate.subject.linkedKeys,
    authority: candidate.subject.identities[0].authority,
    displayName: candidate.subject.displayName,
    handle: candidate.handle,
    route: candidate.subject.subjectKey.startsWith('github:')
      ? { kind: 'github', nodeId: candidate.subject.subjectKey.slice('github:'.length) }
      : { kind: 'none' },
  };
}

export function MentionEditor({
  value,
  mentions,
  localCandidates,
  placeholder,
  disabled,
  autoFocus,
  className,
  providerLabel,
  search,
  onRequestSignIn,
  onChange,
  onKeyDown,
  onClick,
}: Props) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [providerCandidates, setProviderCandidates] = useState<SearchCandidate[]>([]);
  const [searchState, setSearchState] = useState<
    'idle' | 'searching' | 'needs-signin' | 'unavailable' | 'error'
  >('idle');
  const [signInAuthority, setSignInAuthority] = useState<'github' | 'microsoft'>('github');
  const [searchRevision, setSearchRevision] = useState(0);

  useEffect(() => {
    const term = query?.term.trim() || '';
    if (term.length < 2) {
      setProviderCandidates([]);
      setSearchState('idle');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearchState('searching');
      try {
        const outcome = await search(term, controller.signal);
        if (controller.signal.aborted) return;
        if (outcome.kind === 'results') {
          setProviderCandidates(outcome.candidates);
          setSearchState('idle');
        } else {
          setProviderCandidates([]);
          if (outcome.kind === 'needs-signin') setSignInAuthority(outcome.authority);
          setSearchState(outcome.kind);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error('Identity search failed', error);
        setProviderCandidates([]);
        setSearchState('error');
      }
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query?.term, search, searchRevision]);

  const matches = useMemo<PickerCandidate[]>(() => {
    if (!query) return [];
    const resolved: PickerCandidate[] = providerCandidates.map((candidate) => ({
      id: candidate.subject.subjectKey,
      value: candidate.handle,
      displayName: candidate.subject.displayName,
      secondary: candidate.secondaryLabel(),
      source: candidate.source === 'github' ? 'github' : 'entra',
      externalHint: candidate.externalHint,
      resolved: candidate,
    }));
    const used = new Set(resolved.map((candidate) => candidate.value.toLocaleLowerCase()));
    const local = filterCandidates(localCandidates, query.term).flatMap<PickerCandidate>((candidate) => {
      const key = candidate.value.toLocaleLowerCase();
      if (used.has(key)) return [];
      return [
        {
          id: `legacy:${key}`,
          value: candidate.value,
          displayName: candidate.value,
          source: candidate.source,
        },
      ];
    });
    return [...resolved, ...local].slice(0, 10);
  }, [localCandidates, providerCandidates, query]);

  const choose = (candidate: PickerCandidate) => {
    const textarea = inputRef.current;
    if (!query || !textarea) return;
    const caret = textarea.selectionStart ?? value.length;
    const next = applyMention(value, query, caret, candidate.value);
    const mention = candidate.resolved
      ? resolvedMention(candidate.resolved, query.start)
      : ({
          kind: 'unresolved',
          start: query.start,
          length: candidate.value.length + 1,
          text: `@${candidate.value}`,
          handle: candidate.value,
        } satisfies MentionReference);
    const rebasedMentions = reconcileMentionReferences(value, next.text, mentions);
    const nextMentions = [
      ...rebasedMentions.filter(
        (existing) =>
          existing.start + existing.length <= mention.start ||
          existing.start >= mention.start + mention.length
      ),
      mention,
    ];
    onChange(next.text, nextMentions);
    setQuery(null);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(next.caret, next.caret);
    });
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (query && matches.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((index) => (index + 1) % matches.length);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((index) => (index - 1 + matches.length) % matches.length);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(matches[Math.min(selectedIndex, matches.length - 1)]);
        return;
      }
    }
    if (query && event.key === 'Escape') {
      event.preventDefault();
      setQuery(null);
      return;
    }
    onKeyDown?.(event);
  };

  // Show the picker's status row (searching / needs-signin / error) even when
  // local suggestions already matched, so a local candidate (e.g. the viewer's own
  // name or someone already on the thread) never hides the "Sign in to search your
  // Microsoft directory" prompt. Without this, a name that matches a local
  // suggestion can only be inserted as an Unverified mention, which notifies no one.
  // The "no matches" (idle) message still only appears when there are truly none.
  const hasQuery = Boolean(query && query.term.trim().length >= 2);
  const showState =
    hasQuery &&
    (matches.length === 0 ||
      searchState === 'needs-signin' ||
      searchState === 'searching' ||
      searchState === 'error');

  return (
    <div className="mention-editor">
      <textarea
        ref={inputRef}
        autoFocus={autoFocus}
        className={className}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onClick={onClick}
        onChange={(event) => {
          const nextValue = event.target.value;
          onChange(nextValue, reconcileMentionReferences(value, nextValue, mentions));
          setQuery((current) =>
            updateMentionQuery(nextValue, event.target.selectionStart ?? 0, current)
          );
          setSelectedIndex(0);
        }}
        onKeyDown={handleKeyDown}
        onSelect={(event) => {
          const textarea = event.target as HTMLTextAreaElement;
          setQuery((current) =>
            updateMentionQuery(textarea.value, textarea.selectionStart ?? 0, current)
          );
          setSelectedIndex(0);
        }}
        onBlur={() => setQuery(null)}
      />
      {query && matches.length > 0 && (
        <ul className="mention-picker" role="listbox" aria-label="Mention someone">
          {matches.map((candidate, index) => (
            <li key={candidate.id} role="presentation">
              <button
                type="button"
                role="option"
                aria-selected={index === selectedIndex}
                className={index === selectedIndex ? 'active' : ''}
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(candidate);
                }}
              >
                <span className="mention-value">
                  {candidate.displayName}
                  <small>@{candidate.value}</small>
                </span>
                {candidate.source === 'you' && <span className="mention-tag">you</span>}
                {!candidate.resolved && (
                  <span className="mention-tag warning">Unverified</span>
                )}
                {candidate.externalHint === 'b2b-guest' && (
                  <span className="mention-tag warning">Possible guest</span>
                )}
                {candidate.secondary && <span className="mention-tag">{candidate.secondary}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {showState && (
        <div className="mention-picker mention-picker-state" role="status">
          {searchState === 'searching' && 'Searching people…'}
          {searchState === 'idle' && 'No matches — only people who already have access to this document appear here.'}
          {searchState === 'unavailable' &&
            `${providerLabel} search is not configured for this deployment.`}
          {searchState === 'error' && `${providerLabel} search failed. Try again.`}
          {searchState === 'needs-signin' && (
            <>
              <span>
                Sign in to search{' '}
                {signInAuthority === 'microsoft' ? 'your Microsoft directory' : providerLabel}.
              </span>
              <button
                type="button"
                onMouseDown={(event) => {
                  event.preventDefault();
                  void onRequestSignIn(signInAuthority).then(() =>
                    setSearchRevision((revision) => revision + 1)
                  );
                }}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
