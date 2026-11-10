import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AtSign, Check, ChevronDown, ChevronUp, CircleAlert, Copy, CornerDownRight, EllipsisVertical, MessageCircle, PencilLine, Reply, RotateCcw, Sparkles, TextSearch, Trash2 } from 'lucide-react';
import { locateAnchor } from '../anchor';
import type { ReplyDraft } from '../reviewUi';
import { Dialog } from './Dialog';
import { SessionReviewInsights } from './SessionReviewInsights';
import type { Comment, MentionReference, Thread, ThreadIntent } from '../types';
import type { MentionCandidate } from '../mentions';
import { MentionEditor, type IdentitySearchOutcome } from './MentionEditor';
import {
  alignThreadCards,
  deriveWaitingOnIdentities,
  filterThreads,
  isWaitingOnViewer,
  needsReanchor,
  packFocusedThreadCards,
  searchThreads,
  sortThreads,
  summarizeReview,
  threadIntent,
  type ReviewFilter,
  type ThreadSort,
} from '../review';
import {
  buildReviewDigest,
  buildAiSummaryPayload,
  renderDigestText,
  requestAiSummary,
  type SummaryScope,
} from '../reviewSummary';
import {
  assessReadiness,
  requestAiReadiness,
  renderReadinessText,
  type ReadinessAssessment,
  type ReadinessGap,
} from '../readiness';
import { localReviewPass, requestAiReview, type ReviewFinding } from '../aiReview';
import { applyPolicy, type ReviewPolicy } from '../reviewPolicy';
import { tallyReactions, REACTION_EMOJIS, type ReactionEmoji } from '../reactions';
import { diffLines, isSuggestionApplied } from '../suggestion';
import { resolveSkillFromText, type SkillSource } from '../aiSkill';
import {
  clearReviewSessionInsights,
  completeReviewSessionRun,
  createReviewSessionInsights,
  recordReviewSessionOutcome,
  setReviewSessionCapture,
  startReviewSessionRun,
  type FindingAcceptanceOutcome,
  type ReviewSessionInsights,
} from '../reviewSessionInsights';

const INTENT_LABELS: Record<ThreadIntent, string> = {
  question: 'Question',
  suggestion: 'Suggestion',
  blocking: 'Blocking',
};

const INTENT_ICONS = { question: MessageCircle, suggestion: PencilLine, blocking: CircleAlert };
const UNVERIFIED_ALIAS_TITLE = 'Unverified alias; not linked to a verified account';

const REVIEW_FILTERS: { value: ReviewFilter; label: string }[] = [
  { value: 'open', label: 'Open' },
  { value: 'question', label: 'Question' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'blocking', label: 'Blocking' },
  { value: 'mine', label: 'Mine' },
  { value: 'needs-reanchor', label: 'Needs re-anchor' },
  { value: 'all', label: 'All' },
];

const EMPTY_FILTER_MESSAGES: Record<ReviewFilter, string> = {
  open: 'No open threads.',
  question: 'No open questions.',
  suggestion: 'No open suggestions.',
  blocking: 'No blocking threads.',
  mine: 'Nothing is waiting on you.',
  'needs-reanchor': 'No open threads need re-anchoring.',
  all: 'No review threads yet.',
};

// Render a comment body with @mentions styled consistently.
function renderLegacyBody(body: string) {
  const parts = body.split(/(@[A-Za-z\d][A-Za-z\d_-]*)/g);
  return parts.map((p, i) =>
    /^@[A-Za-z\d]/.test(p) ? (
      <span className="mention unresolved" title={UNVERIFIED_ALIAS_TITLE} key={i}>
        {p}
      </span>
    ) : (
      <span key={i}>{p}</span>
    )
  );
}

function renderBody(comment: Comment) {
  if (!comment.mentions?.length) return renderLegacyBody(comment.body);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const mention of [...comment.mentions].sort((left, right) => left.start - right.start)) {
    if (
      mention.start < cursor ||
      mention.start + mention.length > comment.body.length ||
      comment.body.slice(mention.start, mention.start + mention.length) !== mention.text
    ) {
      continue;
    }
    if (mention.start > cursor) parts.push(comment.body.slice(cursor, mention.start));
    parts.push(
      <span
        className={`mention${mention.kind === 'unresolved' ? ' unresolved' : ''}`}
        title={mention.kind === 'unresolved' ? UNVERIFIED_ALIAS_TITLE : undefined}
        key={`${mention.start}:${mention.kind === 'resolved' ? mention.subjectKey : mention.handle}`}
      >
        {mention.text}
      </span>
    );
    cursor = mention.start + mention.length;
  }
  if (cursor < comment.body.length) parts.push(comment.body.slice(cursor));
  return parts;
}

interface Props {
  threadFocusRequest: { id: string } | null;
  onThreadFocused: () => void;
  toolsHost: HTMLDivElement | null;
  controlsHost: HTMLDivElement | null;
  composerHostRef: (node: HTMLDivElement | null) => void;
  documentRoot: HTMLDivElement | null;
  draftAnchor: Thread['anchor'] | null;
  onFocusThread: (threadId: string) => void;
  commentHint: ReactNode;
  replyDrafts: Record<string, ReplyDraft>;
  onReplyDraftChange: (threadId: string, draft: ReplyDraft) => void;
  threads: Thread[];
  activeId: string | null;
  viewerNames: string[];
  viewerIdentityKeys: string[];
  canComment: boolean;
  canMutateShared: boolean;
  canCaptureReviewInsights: boolean;
  reviewSessionContext: string;
  docTitle: string;
  summarizeEndpoint: string;
  /** Raw Markdown of the current document — assessed by the readiness check (#44). */
  markdown: string;
  /** Optional AI readiness endpoint; empty falls back to the local rubric (#44). */
  readinessEndpoint: string;
  /** Promote a readiness gap into a draft review thread at its anchor (#44). */
  onPromoteGap?: (gap: ReadinessGap) => boolean;
  /** Jump the document view to a readiness gap's anchored span (#44). */
  onLocateGap?: (gap: ReadinessGap) => void;
  /** Optional AI reviewer endpoint; empty falls back to the local pass (#43). */
  reviewEndpoint: string;
  /** Load the REVIEW.md policy for the current source, or the default (#89). */
  loadReviewPolicy: (policyPath?: string) => Promise<ReviewPolicy>;
  /** Load an applicable skill from an explicit source or configured defaults (#92). */
  loadSkillSource: (source?: string) => Promise<SkillSource | null>;
  /** Accept an AI review finding — promote it to a draft thread (#43). */
  onAcceptFinding?: (finding: ReviewFinding) => FindingAcceptanceOutcome;
  /** Jump the document view to a draft finding's anchored span (#43). */
  onLocateFinding?: (finding: ReviewFinding) => void;
  mentionCandidates: MentionCandidate[];
  identityProviderLabel: string;
  searchIdentities: (term: string, signal: AbortSignal) => Promise<IdentitySearchOutcome>;
  onRequestIdentitySignIn: (authority: 'github' | 'microsoft') => Promise<void>;
  onReply: (threadId: string, body: string, mentions: MentionReference[]) => boolean;
  onResolve: (threadId: string, resolved: boolean) => void;
  onDelete: (threadId: string) => void;
  onActivate: (threadId: string | null) => void;
  onLocateThread: (threadId: string) => void;
  buildThreadLink: (threadId: string) => string;
  canReact: boolean;
  onReact: (threadId: string, commentId: string, emoji: ReactionEmoji) => void;
  canApplySuggestion: boolean;
  suggestionApplyReason?: string;
  onApplySuggestion: (threadId: string) => void;
  onDismissSuggestion: (threadId: string) => void;
  aiSuggestEnabled: boolean;
  aiDraftingThreadId: string | null;
  onDraftAiSuggestion: (threadId: string, skill?: SkillSource | null) => void;
}

export function CommentGutter({
  threadFocusRequest,
  onThreadFocused,
  toolsHost,
  controlsHost,
  composerHostRef,
  documentRoot,
  draftAnchor,
  onFocusThread,
  commentHint,
  replyDrafts,
  onReplyDraftChange,
  threads,
  activeId,
  viewerNames,
  viewerIdentityKeys,
  canComment,
  canMutateShared,
  canCaptureReviewInsights,
  reviewSessionContext,
  docTitle,
  summarizeEndpoint,
  markdown,
  readinessEndpoint,
  onPromoteGap,
  onLocateGap,
  reviewEndpoint,
  loadReviewPolicy,
  loadSkillSource,
  onAcceptFinding,
  onLocateFinding,
  mentionCandidates,
  identityProviderLabel,
  searchIdentities,
  onRequestIdentitySignIn,
  onReply,
  onResolve,
  onDelete,
  onActivate,
  onLocateThread,
  buildThreadLink,
  canReact,
  onReact,
  canApplySuggestion,
  suggestionApplyReason,
  onApplySuggestion,
  onDismissSuggestion,
  aiSuggestEnabled,
  aiDraftingThreadId,
  onDraftAiSuggestion,
}: Props) {
  const [filter, setFilter] = useState<ReviewFilter>('open');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<ThreadSort>('document');
  const gutterRef = useRef<HTMLDivElement>(null);
  const threadListRef = useRef<HTMLDivElement>(null);
  const [passagePositions, setPassagePositions] = useState(() => new Map<string, number>());
  const [passageMarkers, setPassageMarkers] = useState<{ id: string; number: number; top: number }[]>([]);
  const [draftPosition, setDraftPosition] = useState<number | null>(null);
  const [returnToThread, setReturnToThread] = useState<string | null>(null);
  const [returnVisible, setReturnVisible] = useState(false);
  const [connector, setConnector] = useState<{ left: number; top: number; width: number; height: number; from: number; to: number } | null>(null);
  const summaryPanelRef = useRef<HTMLDivElement>(null);
  const reviewPanelRef = useRef<HTMLDivElement>(null);
  const [summaryState, setSummaryState] = useState<{
    open: boolean;
    loading: boolean;
    text: string;
    source: 'ai' | 'local' | null;
    note: string;
  }>({ open: false, loading: false, text: '', source: null, note: '' });
  const [copied, setCopied] = useState(false);
  const [readiness, setReadiness] = useState<{
    open: boolean;
    loading: boolean;
    assessment: ReadinessAssessment | null;
    note: string;
  }>({ open: false, loading: false, assessment: null, note: '' });
  const [readinessCopied, setReadinessCopied] = useState(false);
  const [promoted, setPromoted] = useState<Set<string>>(new Set());
  const [review, setReview] = useState<{
    open: boolean;
    loading: boolean;
    ran: boolean;
    findings: ReviewFinding[];
    hiddenNits: number;
    policyLabel: string;
    skillLabel: string;
    assessment: ReadinessAssessment | null;
    source: 'ai' | 'local' | null;
    note: string;
  }>({ open: false, loading: false, ran: false, findings: [], hiddenNits: 0, policyLabel: '', skillLabel: '', assessment: null, source: null, note: '' });
  const [policyPath, setPolicyPath] = useState('');
  const [skillSource, setSkillSource] = useState('');
  const [skillText, setSkillText] = useState('');
  const [skillFileName, setSkillFileName] = useState('');
  const [sessionInsights, setSessionInsights] = useState(createReviewSessionInsights);
  const [insightsOpen, setInsightsOpen] = useState(false);
  const insightsRef = useRef(sessionInsights);
  const findingObservations = useRef(new WeakMap<ReviewFinding, string>());
  const displayedFindings = useRef(new Set<ReviewFinding>());
  const reviewRunVersion = useRef(0);
  const updateInsights = (next: ReviewSessionInsights) => {
    insightsRef.current = next;
    setSessionInsights(next);
  };
  useLayoutEffect(() => {
    updateInsights(clearReviewSessionInsights(insightsRef.current, false));
    findingObservations.current = new WeakMap();
    reviewRunVersion.current += 1;
    setReview(previous => previous.loading ? { ...previous, loading: false } : previous);
    return () => {
      insightsRef.current = clearReviewSessionInsights(insightsRef.current, false);
      findingObservations.current = new WeakMap();
      reviewRunVersion.current += 1;
    };
  }, [reviewSessionContext, canCaptureReviewInsights]);
  useLayoutEffect(() => {
    reviewRunVersion.current += 1;
    setReview(previous => previous.loading ? { ...previous, loading: false } : previous);
  }, [markdown]);
  useEffect(() => { if (summaryState.open) summaryPanelRef.current?.focus(); }, [summaryState.open]);
  useEffect(() => { if (review.open) reviewPanelRef.current?.focus(); }, [review.open]);
  const summary = summarizeReview(threads, viewerNames, viewerIdentityKeys);
  // Compose: intent filter → free-text search (#34) → sort (#34).
  const searched = searchThreads(
    filterThreads(threads, filter, viewerNames, viewerIdentityKeys),
    query
  );
  const positions = passagePositions.size ? passagePositions : undefined;
  const filtered = sortThreads(searched, sort, positions);
  const threadNumbers = new Map(sortThreads(threads, 'document', positions).map((thread, index) => [thread.id, index + 1]));
  const activeIndex = filtered.findIndex(thread => thread.id === activeId);
  const previousThread = activeIndex > 0 ? filtered[activeIndex - 1] : undefined;
  const nextVisibleThread = filtered[activeIndex + 1];
  const nextThread = sort === 'document'
    ? filtered.findIndex(thread => (passagePositions.get(thread.id) ?? thread.anchor.start) >= (draftPosition ?? draftAnchor?.start ?? Infinity))
    : 0;
  const draftIndex = !draftAnchor || nextThread < 0 ? filtered.length : nextThread;

  useLayoutEffect(() => {
    const list = threadListRef.current;
    const host = documentRoot?.parentElement;
    const gutter = gutterRef.current;
    if (!list) return;
    if (!documentRoot || !host) {
      list.querySelectorAll<HTMLElement>('[data-review-slot]').forEach(card => card.style.removeProperty('--thread-offset'));
      gutter?.removeAttribute('data-focused-layout');
      list.style.removeProperty('height');
      setConnector(null);
      setPassagePositions(previous => previous.size ? new Map() : previous);
      setPassageMarkers(previous => previous.length ? [] : previous);
      setDraftPosition(null);
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!documentRoot.isConnected || !list.offsetWidth) return;
      const hostRect = host.getBoundingClientRect();
      const scale = list.getBoundingClientRect().width / list.offsetWidth;
      const anchors = new Map<string, { top: number; height: number; position: number }>();
      for (const span of documentRoot.querySelectorAll<HTMLElement>('[data-thread-id]')) {
        const rect = span.getClientRects()[0];
        if (!rect) continue;
        for (const id of (span.dataset.threadIds || span.dataset.threadId || '').split(' ')) {
          if (!anchors.has(id)) anchors.set(id, { top: rect.top, height: rect.height, position: Number(span.dataset.anchorOffset) });
        }
      }
      const nextPositions = new Map(Array.from(anchors, ([id, anchor]) => [id, anchor.position]));
      setPassagePositions(previous => previous.size === nextPositions.size && Array.from(nextPositions).every(([id, position]) => previous.get(id) === position) ? previous : nextPositions);
      const markerTargets = sortThreads(threads, 'document', nextPositions).flatMap((thread, index) => {
        const anchor = anchors.get(thread.id);
        if (!anchor) return [];
        const top = (anchor.top - hostRect.top) / scale + host.scrollTop - host.clientTop - 1;
        return [{ id: thread.id, number: index + 1, top, height: 22 }];
      });
      const markerLabels = new Map(markerTargets.map(marker => [marker.id, marker.number]));
      const markerPriority = markerTargets[0]?.id;
      const markerOrigin = Math.min(...markerTargets.map(marker => marker.top));
      const markers = markerPriority ? packFocusedThreadCards(markerTargets.map(marker => ({ ...marker, top: marker.top - markerOrigin })), markerPriority, 4)
        .map(marker => ({ id: marker.id, top: marker.top + markerOrigin, number: markerLabels.get(marker.id)! })) : [];
      setPassageMarkers(previous => previous.length === markers.length && markers.every((marker, index) => marker.id === previous[index].id && marker.number === previous[index].number && Math.abs(marker.top - previous[index].top) < 0.5) ? previous : markers);
      if (markers.length) host.setAttribute('data-thread-markers', '');
      else host.removeAttribute('data-thread-markers');
      let draft: ReturnType<typeof locateAnchor> = null;
      try { draft = draftAnchor ? locateAnchor(documentRoot, draftAnchor) : null; } catch { draft = null; }
      setDraftPosition(draft?.startOffset ?? null);
      const draftRect = draft?.range.getClientRects()[0];
      const sideBySide = hostRect.right <= list.getBoundingClientRect().left + 1;
      const aligned = sort === 'document' && sideBySide;
      const focusId = draftRect ? 'draft-composer' : activeId;
      const focusTop = draftRect?.top ?? (activeId ? anchors.get(activeId)?.top : undefined);
      const focused = aligned && focusId !== null && focusTop !== undefined;
      gutter?.toggleAttribute('data-focused-layout', focused);
      if (!focused) list.style.removeProperty('height');
      const listRect = list.getBoundingClientRect();
      const cards = Array.from(list.querySelectorAll<HTMLElement>('[data-review-slot]')).filter(card => card.offsetHeight > 0);
      cards.forEach(card => resize.observe(card));
      const cardId = (card: HTMLElement) => card.hasAttribute('data-compose-slot') ? 'draft-composer' : card.dataset.reviewSlot || '';
      if (focused) {
        const rank = new Map(filtered.map((thread, index) => [thread.id, index * 2 + 1]));
        rank.set('draft-composer', draftIndex * 2);
        cards.sort((left, right) => (rank.get(cardId(left)) ?? Infinity) - (rank.get(cardId(right)) ?? Infinity));
        const layout = packFocusedThreadCards(cards.map(card => ({
          id: cardId(card),
          height: card.offsetHeight,
          top: ((card.hasAttribute('data-compose-slot') ? draftRect?.top : anchors.get(card.dataset.reviewSlot || '')?.top) ?? listRect.top) / scale - listRect.top / scale,
        })), focusId);
        const byId = new Map(layout.map(card => [card.id, card]));
        for (const card of cards) {
          const position = byId.get(cardId(card));
          if (position) card.style.setProperty('--thread-top', `${position.top}px`);
          card.style.removeProperty('--thread-offset');
        }
        const last = layout[layout.length - 1];
        list.style.height = last ? `${last.top + last.height}px` : '';
        const selected = activeId && !draftRect ? byId.get(activeId) : undefined;
        const anchor = activeId ? anchors.get(activeId) : undefined;
        const main = host.parentElement?.getBoundingClientRect();
        if (selected && anchor && main && Math.abs(listRect.top / scale + selected.top - anchor.top / scale) > 16) {
          const quote = cards.find(card => cardId(card) === activeId)?.querySelector<HTMLElement>('.quote');
          const from = (anchor.top + anchor.height / 2 - main.top) / scale;
          const to = (listRect.top - main.top) / scale + selected.top + (quote?.offsetHeight ?? 24) / 2;
          const top = Math.min(from, to) - 1;
          const next = { left: (hostRect.right - main.left) / scale, top, width: Math.max(0, (listRect.left - hostRect.right) / scale), height: Math.abs(to - from) + 2, from: from - top, to: to - top };
          setConnector(previous => previous && Object.keys(next).every(key => Math.abs(previous[key as keyof typeof next] - next[key as keyof typeof next]) < 0.5) ? previous : next);
        } else setConnector(null);
        return;
      }
      setConnector(null);
      const measured = cards.map(card => {
        const anchorTop = card.hasAttribute('data-compose-slot') ? draftRect?.top : anchors.get(card.dataset.reviewSlot || '')?.top;
        return {
          top: card.getBoundingClientRect().top / scale,
          offset: parseFloat(card.style.getPropertyValue('--thread-offset')) || 0,
          anchorTop: aligned && anchorTop !== undefined ? anchorTop / scale : undefined,
        };
      });
      alignThreadCards(measured).forEach((offset, index) => {
        if (Math.abs(offset - measured[index].offset) > 0.5) cards[index].style.setProperty('--thread-offset', `${offset}px`);
      });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resize = new ResizeObserver(schedule);
    resize.observe(host);
    resize.observe(list);
    const mutations = new MutationObserver(schedule);
    mutations.observe(documentRoot, { childList: true, subtree: true });
    mutations.observe(list, { childList: true, subtree: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      host.removeAttribute('data-thread-markers');
    };
  }, [documentRoot, threads, sort, draftAnchor, activeId, filter, query, draftIndex]);

  useEffect(() => {
    const roots = [documentRoot?.parentElement, gutterRef.current].filter((root): root is HTMLElement => Boolean(root));
    const selector = '[data-thread-id], [data-review-thread], [data-passage-thread]';
    const ids = (element: HTMLElement) => (element.dataset.threadIds || element.dataset.threadId || element.dataset.reviewThread || element.dataset.passageThread || '').split(' ');
    const targetId = (target: EventTarget | null) => {
      const element = target instanceof Element ? target.closest<HTMLElement>(selector) : null;
      if (!element) return null;
      const matches = ids(element);
      return activeId && matches.includes(activeId) ? activeId : matches[0];
    };
    let hovered: EventTarget | null = null;
    let focused: EventTarget | null = document.activeElement;
    const paint = () => {
      const id = targetId(hovered) || targetId(focused);
      roots.forEach(root => root.querySelectorAll<HTMLElement>(selector).forEach(element => element.classList.toggle('paired', Boolean(id && ids(element).includes(id)))));
    };
    const over = (event: PointerEvent) => { hovered = event.target; paint(); };
    const out = (event: PointerEvent) => { hovered = event.relatedTarget; paint(); };
    const focus = (event: FocusEvent) => { focused = event.target; paint(); };
    const blur = (event: FocusEvent) => { focused = event.relatedTarget; paint(); };
    roots.forEach(root => {
      root.addEventListener('pointerover', over);
      root.addEventListener('pointerout', out);
      root.addEventListener('focusin', focus);
      root.addEventListener('focusout', blur);
    });
    paint();
    return () => roots.forEach(root => {
      root.removeEventListener('pointerover', over);
      root.removeEventListener('pointerout', out);
      root.removeEventListener('focusin', focus);
      root.removeEventListener('focusout', blur);
      root.querySelectorAll('.paired').forEach(element => element.classList.remove('paired'));
    });
  }, [documentRoot, activeId, threads]);

  useEffect(() => {
    setReturnVisible(false);
    if (!returnToThread || returnToThread !== activeId) { setReturnToThread(null); return; }
    const card = Array.from(threadListRef.current?.querySelectorAll<HTMLElement>('[data-review-thread]') || []).find(element => element.dataset.reviewThread === returnToThread);
    const quote = card?.querySelector('.quote');
    if (!quote) { setReturnToThread(null); return; }
    const observer = new IntersectionObserver(([entry]) => setReturnVisible(entry.intersectionRatio < 1), { threshold: 1, rootMargin: '-12px 0px' });
    observer.observe(quote);
    return () => observer.disconnect();
  }, [returnToThread, activeId, filter, query, documentRoot]);

  useEffect(() => {
    if (!draftAnchor) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const input = threadListRef.current?.querySelector<HTMLTextAreaElement>('[data-compose-slot] textarea');
        const rect = input?.getBoundingClientRect();
        if (rect && (rect.top < 12 || rect.bottom > window.innerHeight - 12)) input?.scrollIntoView({ block: 'nearest' });
        input?.focus({ preventScroll: true });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [draftAnchor]);
  // Filter-tab counts reflect the active search so the badges track what's shown.
  const searchCount = (list: Thread[]) => searchThreads(list, query).length;
  const openThreads = threads.filter((thread) => !thread.resolved);
  const filterCounts: Record<ReviewFilter, number> = {
    open: searchCount(openThreads),
    question: searchCount(openThreads.filter((t) => threadIntent(t) === 'question')),
    suggestion: searchCount(openThreads.filter((t) => threadIntent(t) === 'suggestion')),
    blocking: searchCount(openThreads.filter((t) => threadIntent(t) === 'blocking')),
    mine: searchCount(
      openThreads.filter((t) => isWaitingOnViewer(t, viewerNames, viewerIdentityKeys))
    ),
    'needs-reanchor': searchCount(openThreads.filter((t) => needsReanchor(t))),
    all: searchCount(threads),
  };
  useEffect(() => {
    if (activeId && threads.some(thread => thread.id === activeId) && !filtered.some(thread => thread.id === activeId)) {
      setFilter('all');
      setQuery('');
    }
  }, [activeId]);
  useEffect(() => {
    if (!threadFocusRequest) return;
    setReturnToThread(null);
    if (!filtered.some(thread => thread.id === threadFocusRequest.id)) {
      if (filter !== 'all' || query) { setFilter('all'); setQuery(''); }
      else onThreadFocused();
      return;
    }
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const card = Array.from(gutterRef.current?.querySelectorAll<HTMLElement>('[data-review-thread]') || []).find(element => element.dataset.reviewThread === threadFocusRequest.id);
        const cardRect = card?.getBoundingClientRect();
        const target = cardRect && cardRect.height > window.innerHeight - 24 ? card?.querySelector<HTMLElement>('.quote') : card;
        if (gutterRef.current?.hasAttribute('data-focused-layout')) {
          const passage = Array.from(documentRoot?.querySelectorAll<HTMLElement>('[data-thread-id]') || [])
            .find(span => (span.dataset.threadIds || span.dataset.threadId || '').split(' ').includes(threadFocusRequest.id));
          const rect = passage?.getClientRects()[0];
          const targetRect = target?.getBoundingClientRect();
          const top = Math.min(rect?.top ?? Infinity, targetRect?.top ?? Infinity);
          const bottom = Math.max(rect?.bottom ?? -Infinity, targetRect?.bottom ?? -Infinity);
          if (rect && targetRect && bottom - top <= window.innerHeight - 24) {
            if (top < 12) window.scrollBy({ top: top - 12 });
            else if (bottom > window.innerHeight - 12) window.scrollBy({ top: bottom - window.innerHeight + 12 });
          } else target?.scrollIntoView({ block: 'nearest' });
        } else target?.scrollIntoView({ block: 'nearest' });
        card?.focus({ preventScroll: true });
        onThreadFocused();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [threadFocusRequest, filter, query]);

  // Read-only AI-assisted digest of the current threads. Honors the panel filter
  // (All vs everything else → open). Uses the AI endpoint when configured and
  // reachable; otherwise falls back to a deterministic local digest. Nothing is
  // persisted or mutated.
  const onSummarize = async () => {
    const scope: SummaryScope = filter === 'all' ? 'all' : 'open';
    const digest = buildReviewDigest(threads, scope, docTitle);
    const localText = renderDigestText(digest);
    setCopied(false);
    if (!summarizeEndpoint) {
      setSummaryState({ open: true, loading: false, text: localText, source: 'local', note: '' });
      return;
    }
    setSummaryState({ open: true, loading: true, text: '', source: null, note: '' });
    const result = await requestAiSummary(
      summarizeEndpoint,
      buildAiSummaryPayload(threads, scope, docTitle)
    );
    if (result.text) {
      setSummaryState({ open: true, loading: false, text: result.text, source: 'ai', note: '' });
    } else {
      setSummaryState({
        open: true,
        loading: false,
        text: localText,
        source: 'local',
        note: `AI summary unavailable (${result.reason || 'unknown'}) — showing a locally generated digest.`,
      });
    }
  };

  const onCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryState.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  // Read-only AI-readiness assessment of the current document (#44). Uses the AI
  // endpoint when configured and reachable; otherwise a deterministic local rubric.
  // Nothing is persisted or mutated — gaps are promoted to threads only on demand.
  const onAssessReadiness = async () => {
    setReadinessCopied(false);
    setPromoted(new Set());
    const local = assessReadiness(markdown, docTitle);
    if (!readinessEndpoint) {
      setReadiness({ open: true, loading: false, assessment: local, note: '' });
      return;
    }
    setReadiness({ open: true, loading: true, assessment: null, note: '' });
    const result = await requestAiReadiness(readinessEndpoint, markdown, docTitle);
    if (result.ok) {
      setReadiness({ open: true, loading: false, assessment: result.assessment, note: '' });
    } else {
      setReadiness({
        open: true,
        loading: false,
        assessment: local,
        note: `AI readiness unavailable (${result.reason || 'unknown'}) — showing a locally graded assessment.`,
      });
    }
  };

  const onCopyReadiness = async () => {
    if (!readiness.assessment) return;
    try {
      await navigator.clipboard.writeText(renderReadinessText(readiness.assessment));
      setReadinessCopied(true);
      setTimeout(() => setReadinessCopied(false), 2000);
    } catch {
      /* clipboard unavailable — ignore */
    }
  };

  const onPromote = (gap: ReadinessGap) => {
    if (!onPromoteGap || !gap.anchor) return;
    if (!onPromoteGap(gap)) return;
    setPromoted((prev) => new Set(prev).add(gap.id));
  };

  const selectedSkillFromUi = (): SkillSource | null => {
    const pasted = skillText.trim();
    return pasted ? resolveSkillFromText(pasted, skillFileName || 'pasted skill') : null;
  };

  const resolveActiveSkill = async (): Promise<SkillSource | null> =>
    selectedSkillFromUi() || (await loadSkillSource(skillSource.trim() || undefined));

  const readinessGapToFinding = (
    gap: ReadinessGap,
    index: number,
    source: ReadinessAssessment['source']
  ): ReviewFinding => ({
    id: `readiness-${gap.id}-${index}`,
    anchor: gap.anchor || { quote: docTitle, prefix: '', suffix: '', start: 0 },
    intent: gap.severity === 'critical' ? 'blocking' : gap.severity === 'important' ? 'suggestion' : 'question',
    severity: gap.severity === 'minor' ? 'nit' : 'important',
    pass: 'readiness',
    title: gap.title,
    rationale: gap.detail,
    ...(gap.replacement ? { replacement: gap.replacement } : {}),
    ...(gap.skillName ? { skillName: gap.skillName } : {}),
    origin: source === 'ai' ? 'ai' : 'local',
  });

  // Unified AI review (#43 + #44): readiness score first, then readiness gaps and
  // review findings, governed by REVIEW.md and optionally grounded in one skill.
  const onRunReview = async () => {
    const version = ++reviewRunVersion.current;
    const started = startReviewSessionRun(insightsRef.current);
    updateInsights(started.session);
    displayedFindings.current = new Set();
    setReview((prev) => ({ ...prev, open: true, loading: true, note: '' }));
    setReadinessCopied(false);
    setPromoted(new Set());
    let policy: ReviewPolicy;
    try {
      policy = await loadReviewPolicy(policyPath.trim() || undefined);
    } catch {
      const { DEFAULT_POLICY } = await import('../reviewPolicy');
      policy = DEFAULT_POLICY;
    }
    if (version !== reviewRunVersion.current) return;
    const policyLabel = policy.source === 'REVIEW.md' ? 'REVIEW.md' : 'default policy';

    let activeSkill: SkillSource | null = null;
    let skillNote = '';
    try {
      activeSkill = await resolveActiveSkill();
    } catch (error: any) {
      skillNote = ` Skill unavailable (${error?.message || String(error)}) — running without skill grounding.`;
    }
    if (version !== reviewRunVersion.current) return;
    const skillLabel = activeSkill?.skill.name || '';

    const localAssessment = assessReadiness(markdown, docTitle, undefined, activeSkill?.skill);
    let assessment = localAssessment;
    let readinessNote = '';
    if (readinessEndpoint) {
      const result = await requestAiReadiness(readinessEndpoint, markdown, docTitle, activeSkill?.skill);
      if (version !== reviewRunVersion.current) return;
      if (result.ok) assessment = result.assessment;
      else readinessNote = `AI readiness unavailable (${result.reason || 'unknown'}) — showing a locally graded assessment.`;
    }

    let findings: ReviewFinding[] = [];
    let source: 'ai' | 'local' = 'local';
    let note = '';
    if (reviewEndpoint) {
      const result = await requestAiReview(reviewEndpoint, markdown, docTitle, policy, activeSkill?.skill);
      if (version !== reviewRunVersion.current) return;
      if (result.ok) {
        findings = result.findings;
        source = 'ai';
      } else {
        findings = localReviewPass(markdown, policy);
        source = 'local';
        note = `AI review unavailable (${result.reason || 'unknown'}) — showing a locally generated pass.`;
      }
    } else {
      findings = localReviewPass(markdown, policy);
    }
    if (activeSkill) {
      findings = findings.map((finding) => ({ ...finding, skillName: activeSkill.skill.name }));
    }
    const { shown, hiddenNits } = applyPolicy(findings, policy);
    const readinessFindings = assessment.gaps.map((gap, index) =>
      readinessGapToFinding(gap, index, assessment.source)
    );
    const displayed = [...readinessFindings, ...shown];
    const previous = insightsRef.current;
    const completed = completeReviewSessionRun(previous, started.run, displayed.map(finding => ({
      origin: finding.origin, pass: finding.pass, severity: finding.severity,
    })));
    findingObservations.current = new WeakMap();
    completed.observations.slice(previous.observations.length).forEach((observation, index) => {
      findingObservations.current.set(displayed[index], observation.id);
    });
    updateInsights(completed);
    displayedFindings.current = new Set(displayed);
    setReview({
      open: true,
      loading: false,
      ran: true,
      findings: displayed,
      hiddenNits,
      policyLabel,
      skillLabel,
      assessment,
      source,
      note: [readinessNote, note, skillNote].filter(Boolean).join(' '),
    });
  };

  const onAccept = (finding: ReviewFinding) => {
    if (!onAcceptFinding || !displayedFindings.current.has(finding)) return;
    const outcome = onAcceptFinding(finding);
    if (outcome === 'failed') return;
    displayedFindings.current.delete(finding);
    updateInsights(recordReviewSessionOutcome(insightsRef.current, findingObservations.current.get(finding), outcome));
    setReview((prev) => ({ ...prev, findings: prev.findings.filter(candidate => candidate !== finding) }));
  };

  const onDismissFinding = (finding: ReviewFinding) => {
    if (!displayedFindings.current.has(finding)) return;
    displayedFindings.current.delete(finding);
    updateInsights(recordReviewSessionOutcome(insightsRef.current, findingObservations.current.get(finding), 'dismissed'));
    setReview((prev) => ({ ...prev, findings: prev.findings.filter(candidate => candidate !== finding) }));
  };

  const draftAiSuggestionWithSkill = async (threadId: string) => {
    let activeSkill: SkillSource | null = null;
    try {
      activeSkill = await resolveActiveSkill();
    } catch {
      activeSkill = null;
    }
    onDraftAiSuggestion(threadId, activeSkill);
  };

  const renderThread = (thread: Thread) => (
    <ThreadCard
      key={`thread:${thread.id}`}
      commentNumber={threadNumbers.get(thread.id)!}
      replyDraft={replyDrafts[thread.id] || { body: '', mentions: [] }}
      onReplyDraftChange={draft => onReplyDraftChange(thread.id, draft)}
      thread={thread}
      active={thread.id === activeId}
      viewerNames={viewerNames}
      viewerIdentityKeys={viewerIdentityKeys}
      canComment={canComment}
      canMutateShared={canMutateShared}
      mentionCandidates={mentionCandidates}
      identityProviderLabel={identityProviderLabel}
      searchIdentities={searchIdentities}
      onRequestIdentitySignIn={onRequestIdentitySignIn}
      onReply={onReply}
      onResolve={onResolve}
      onDelete={onDelete}
      onActivate={onActivate}
      onLocateThread={id => { setReturnToThread(id); onLocateThread(id); }}
      buildThreadLink={buildThreadLink}
      canReact={canReact}
      onReact={onReact}
      canApplySuggestion={canApplySuggestion}
      suggestionApplyReason={suggestionApplyReason}
      onApplySuggestion={onApplySuggestion}
      onDismissSuggestion={onDismissSuggestion}
      aiSuggestEnabled={aiSuggestEnabled}
      aiDrafting={aiDraftingThreadId === thread.id}
      onDraftAiSuggestion={draftAiSuggestionWithSkill}
    />
  );
  const listItems = filtered.map(renderThread);
  listItems.splice(draftIndex, 0, <div key="draft-composer" className="composer-host" data-review-slot="" data-compose-slot ref={composerHostRef} />);

  return (
    <div className="gutter" data-docthread-ui ref={gutterRef}>
      {connector && documentRoot?.parentElement?.parentElement && createPortal(
        <div className="passage-connection-layer" aria-hidden="true">
          <svg className="passage-connector" style={{ left: connector.left, top: connector.top }} width={connector.width} height={connector.height}>
            <path d={`M0 ${connector.from} H${connector.width / 2} V${connector.to} H${connector.width}`} />
          </svg>
        </div>, documentRoot.parentElement.parentElement
      )}
      {returnToThread && returnVisible && createPortal(
        <button type="button" className="return-to-comment" data-docthread-ui onClick={() => { setReturnToThread(null); onFocusThread(returnToThread); }}>
          <CornerDownRight size={16} aria-hidden="true" />Back to comment {threadNumbers.get(returnToThread)}
        </button>, document.body
      )}
      {documentRoot?.parentElement && passageMarkers.length > 0 && createPortal(
        <nav className="passage-markers" data-docthread-ui aria-label="Passage comments">
          {passageMarkers.map(marker => (
            <button
              key={marker.id}
              type="button"
              className={`passage-marker${marker.id === activeId ? ' active' : ''}`}
              data-passage-thread={marker.id}
              style={{ top: marker.top }}
              aria-label={`Show comment ${marker.number}`}
              aria-current={marker.id === activeId ? 'true' : undefined}
              title={`Show comment ${marker.number}`}
              onMouseUp={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); onFocusThread(marker.id); }}
            >{marker.number}</button>
          ))}
        </nav>, documentRoot.parentElement
      )}
      {toolsHost && createPortal(
        <div onClick={() => toolsHost.closest('details')?.removeAttribute('open')}>
          <button type="button" onClick={onRunReview} disabled={review.loading}>
            {review.loading ? 'Reviewing...' : 'AI Review'}
          </button>
          <button type="button" onClick={onSummarize} disabled={summaryState.loading}>
            {summaryState.loading ? 'Summarizing...' : 'Summarize review'}
          </button>
          <button type="button" onClick={() => setInsightsOpen(true)}>Session review insights</button>
        </div>,
        toolsHost
      )}
      {insightsOpen && <SessionReviewInsights
        session={sessionInsights}
        canCapture={canCaptureReviewInsights}
        returnFocusTo={toolsHost?.closest('details')?.querySelector('summary')}
        onCaptureChange={enabled => {
          updateInsights(setReviewSessionCapture(insightsRef.current, enabled && canCaptureReviewInsights));
          findingObservations.current = new WeakMap();
        }}
        onClear={() => {
          updateInsights(clearReviewSessionInsights(insightsRef.current, canCaptureReviewInsights));
          findingObservations.current = new WeakMap();
        }}
        onClose={() => setInsightsOpen(false)}
      />}
      <div className="review-heading">
        {controlsHost && createPortal(<div className="review-caption">
        <div className="review-heading-row">
          <h2>Comments</h2>
          <div className="comment-navigation" role="group" aria-label="Comment navigation">
            <button type="button" title="Previous comment" aria-label="Previous comment" disabled={!previousThread} onClick={() => previousThread && onFocusThread(previousThread.id)}><ChevronUp size={16} aria-hidden="true" /></button>
            <button type="button" title="Next comment" aria-label="Next comment" disabled={!nextVisibleThread} onClick={() => nextVisibleThread && onFocusThread(nextVisibleThread.id)}><ChevronDown size={16} aria-hidden="true" /></button>
          </div>
        </div>
        <div
          className="review-status"
          aria-live="polite"
          aria-label={`${summary.open} open, ${summary.blocking} blocking, ${summary.waitingOnViewer} waiting on you`}
        >
          <span>{summary.open} open</span>
          <span aria-hidden>·</span>
          <span>{summary.blocking} blocking</span>
          <span aria-hidden>·</span>
          <span>{summary.waitingOnViewer} waiting on you</span>
        </div>
        </div>, controlsHost)}
        {review.open && <details className="review-grounding">
          <summary>Ground review with REVIEW.md / skill</summary>
          <div className="review-grounding-grid">
            <label>
              <span>REVIEW.md path or URL</span>
              <input
                type="text"
                value={policyPath}
                placeholder="REVIEW.md"
                onChange={(event) => setPolicyPath(event.target.value)}
              />
            </label>
            <label>
              <span>Skill path or URL</span>
              <input
                type="text"
                value={skillSource}
                placeholder=".docthread/skills/prd/SKILL.md, brand-voice.md, or https://..."
                onChange={(event) => setSkillSource(event.target.value)}
              />
            </label>
            <label className="review-grounding-file">
              <span>Upload any Markdown/text skill</span>
              <input
                type="file"
                accept=".md,.markdown,.txt,text/markdown,text/plain"
                onChange={async (event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setSkillFileName(file.name);
                  setSkillText(await file.text());
                }}
              />
            </label>
            <label className="review-grounding-raw">
              <span>Or paste skill content</span>
              <textarea
                value={skillText}
                placeholder="Paste a skill body here; frontmatter name or first heading becomes the skill name."
                onChange={(event) => {
                  setSkillText(event.target.value);
                  if (!skillFileName) setSkillFileName('pasted skill');
                }}
              />
            </label>
          </div>
        </details>}
      </div>
      {summaryState.open && (
        <div className="review-summary" role="region" aria-label="Review summary" tabIndex={-1} ref={summaryPanelRef}>
          <div className="review-summary-head">
            <span className="review-summary-title">
              Summary
              {summaryState.source && (
                <span className={`review-summary-badge ${summaryState.source}`}>
                  {summaryState.source === 'ai' ? 'AI-generated' : 'Generated locally'}
                </span>
              )}
            </span>
            <span className="review-summary-actions">
              {!summaryState.loading && summaryState.text && (
                <button type="button" onClick={onCopySummary} title="Copy summary to clipboard">
                  {copied ? 'Copied' : 'Copy'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setSummaryState((prev) => ({ ...prev, open: false }))}
                aria-label="Dismiss summary"
                title="Dismiss"
              >
                ✕
              </button>
            </span>
          </div>
          {summaryState.note && <p className="review-summary-note">{summaryState.note}</p>}
          {summaryState.loading ? (
            <p className="review-summary-note">Summarizing the current review…</p>
          ) : (
            <pre className="review-summary-body">{summaryState.text}</pre>
          )}
        </div>
      )}
      {readiness.open && (
        <div className="review-summary readiness-panel" role="region" aria-label="AI-readiness assessment">
          <div className="review-summary-head">
            <span className="review-summary-title">
              AI-readiness
              {readiness.assessment && (
                <span className={`review-summary-badge ${readiness.assessment.source}`}>
                  {readiness.assessment.source === 'ai' ? 'AI-graded' : 'Graded locally'}
                </span>
              )}
            </span>
            <span className="review-summary-actions">
              {!readiness.loading && readiness.assessment && (
                <button type="button" onClick={onCopyReadiness} title="Copy assessment to clipboard">
                  {readinessCopied ? 'Copied' : 'Copy'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setReadiness((prev) => ({ ...prev, open: false }))}
                aria-label="Dismiss readiness assessment"
                title="Dismiss"
              >
                ✕
              </button>
            </span>
          </div>
          {readiness.note && <p className="review-summary-note">{readiness.note}</p>}
          {readiness.loading ? (
            <p className="review-summary-note">Assessing the document…</p>
          ) : readiness.assessment ? (
            <div className="readiness-body">
              <div className={`readiness-score grade-${readiness.assessment.grade.toLowerCase()}`}>
                <span className="readiness-grade" aria-hidden>
                  {readiness.assessment.grade}
                </span>
                <span className="readiness-score-num">
                  {readiness.assessment.score}
                  <span className="readiness-score-den">/100</span>
                </span>
                <span className={`readiness-label ${readiness.assessment.label}`}>
                  {readiness.assessment.label === 'ready'
                    ? 'Ready'
                    : readiness.assessment.label === 'needs-work'
                    ? 'Needs work'
                    : 'Not ready'}
                </span>
              </div>
              {readiness.assessment.gaps.length === 0 ? (
                <p className="review-summary-note">No gaps found — every readiness check passed. 🎉</p>
              ) : (
                <ul className="readiness-gaps">
                  {readiness.assessment.gaps.map((gap) => {
                    const canLocate = Boolean(onLocateGap && gap.anchor);
                    return (
                    <li
                      key={gap.id}
                      className={`readiness-gap sev-${gap.severity}${canLocate ? ' locatable' : ''}`}
                      onClick={canLocate ? () => onLocateGap!(gap) : undefined}
                      onKeyDown={
                        canLocate
                          ? (event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault();
                                onLocateGap!(gap);
                              }
                            }
                          : undefined
                      }
                      role={canLocate ? 'button' : undefined}
                      tabIndex={canLocate ? 0 : undefined}
                      title={canLocate ? 'Jump to this location in the document' : undefined}
                    >
                      <div className="readiness-gap-head">
                        <span className={`readiness-sev sev-${gap.severity}`}>{gap.severity}</span>
                        <span className="readiness-gap-title">{gap.title}</span>
                        {canLocate && <span className="review-finding-jump" aria-hidden>↧ jump</span>}
                      </div>
                      <p className="readiness-gap-detail">{gap.detail}</p>
                      {canComment && onPromoteGap && gap.anchor && (
                        <button
                          type="button"
                          className="readiness-discuss"
                          onClick={(event) => {
                            event.stopPropagation();
                            onPromote(gap);
                          }}
                          disabled={promoted.has(gap.id)}
                          title="Open a review thread for this gap"
                        >
                          {promoted.has(gap.id) ? 'Thread created' : 'Discuss'}
                        </button>
                      )}
                    </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}
      {review.open && (
        <div className="review-summary review-pass-panel" role="region" aria-label="AI review findings" tabIndex={-1} ref={reviewPanelRef}>
          <div className="review-summary-head">
            <span className="review-summary-title">
              AI review
              {review.source && (
                <span className={`review-summary-badge ${review.source}`}>
                  {review.source === 'ai' ? 'AI-drafted' : 'Local pass'}
                </span>
              )}
              {review.ran && !review.loading && (
                <span className="review-policy-badge" title="Governing review policy">
                  policy: {review.policyLabel}
                </span>
              )}
              {review.ran && !review.loading && review.skillLabel && (
                <span className="review-policy-badge" title="Grounding skill">
                  skill: {review.skillLabel}
                </span>
              )}
            </span>
            <span className="review-summary-actions">
              <button
                type="button"
                onClick={() => setReview((prev) => ({ ...prev, open: false }))}
                aria-label="Dismiss review findings"
                title="Dismiss"
              >
                ✕
              </button>
            </span>
          </div>
          {review.note && <p className="review-summary-note">{review.note}</p>}
          {review.loading ? (
            <p className="review-summary-note">Running readiness scoring and the AI review pass…</p>
          ) : (
            <div className="readiness-body">
              {review.assessment && (
                <div className={`readiness-score grade-${review.assessment.grade.toLowerCase()}`}>
                  <span className="readiness-grade" aria-hidden>
                    {review.assessment.grade}
                  </span>
                  <span className="readiness-score-num">
                    {review.assessment.score}
                    <span className="readiness-score-den">/100</span>
                  </span>
                  <span className={`readiness-label ${review.assessment.label}`}>
                    {review.assessment.label === 'ready'
                      ? 'Ready'
                      : review.assessment.label === 'needs-work'
                      ? 'Needs work'
                      : 'Not ready'}
                  </span>
                </div>
              )}
              <p className="review-summary-note review-pass-hint">
                {review.findings.length > 0
                  ? 'Draft findings'
                  : review.ran
                  ? 'No findings.'
                  : ''}
              </p>
              {review.findings.length > 0 && (
                <ul className="readiness-gaps">
                  {review.findings.map((finding) => (
                    <li
                      key={finding.id}
                      className={`readiness-gap review-finding sev-${finding.severity === 'important' ? 'important' : 'minor'}${onLocateFinding ? ' locatable' : ''}`}
                      onClick={onLocateFinding ? () => onLocateFinding(finding) : undefined}
                      title={onLocateFinding ? 'Jump to this location in the document' : undefined}
                    >
                      <div className="readiness-gap-head">
                        <span className={`readiness-sev sev-${finding.severity === 'important' ? 'important' : 'minor'}`}>
                          {finding.severity}
                        </span>
                        <span className="review-pass-tag">{finding.pass}</span>
                        <span className="review-intent-tag">{finding.intent}</span>
                        <span className="readiness-gap-title">{onLocateFinding ? (
                          <button type="button" className="review-finding-location" aria-label={`Show passage: ${finding.title}`}
                            onClick={event => { event.stopPropagation(); onLocateFinding(finding); }}>
                            {finding.title}
                          </button>
                        ) : finding.title}</span>
                        {onLocateFinding && <span className="review-finding-jump" aria-hidden>↧ jump</span>}
                      </div>
                      {finding.rationale && <p className="readiness-gap-detail">{finding.rationale}</p>}
                      <blockquote className="review-finding-quote">“{finding.anchor.quote}”</blockquote>
                      {finding.replacement ? (
                        <div className="review-finding-fix">
                          <p className="review-finding-fix-label">Proposed replacement:</p>
                          <div className="suggestion-diff" aria-label="Proposed replacement">
                            {diffLines(finding.anchor.quote, finding.replacement).map((line, index) => (
                              <div key={index} className={`diff-line ${line.kind}`}>
                                <span className="diff-sign" aria-hidden>
                                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                                </span>
                                <span className="diff-text">{line.text || '\u00a0'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <p className="review-finding-fix review-finding-nofix">
                          No auto-fix — needs manual review.
                        </p>
                      )}
                      <div className="review-finding-actions" onClick={(event) => event.stopPropagation()}>
                        {canComment && onAcceptFinding && (
                          <button
                            type="button"
                            className="readiness-discuss"
                            onClick={() => onAccept(finding)}
                            title={
                              finding.replacement
                                ? 'Apply the proposed fix to the document (read-only sources attach it as a suggestion to apply after sign-in)'
                                : 'Promote this finding to a review thread'
                            }
                          >
                            {finding.replacement && canApplySuggestion ? 'Post thread and apply to draft' : 'Post as thread'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="review-dismiss-btn"
                          onClick={() => onDismissFinding(finding)}
                          title="Discard this finding"
                        >
                          Dismiss
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {review.hiddenNits > 0 && (
                <p className="review-summary-note">
                  + {review.hiddenNits} more nit{review.hiddenNits === 1 ? '' : 's'} hidden by the policy nit cap.
                </p>
              )}
            </div>
          )}
        </div>
      )}
      {controlsHost && createPortal(<div className="review-search">
        <input
          type="search"
          className="review-search-input"
          placeholder="Search comments, authors, @mentions…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            onActivate(null);
          }}
          aria-label="Search discussions"
        />
        <label className="review-sort">
          <span className="review-sort-label">Show</span>
          <select value={filter} aria-label="Filter discussions" onChange={(event) => { setFilter(event.target.value as ReviewFilter); onActivate(null); }}>
            {REVIEW_FILTERS.map((option) => <option key={option.value} value={option.value}>{option.label} ({filterCounts[option.value]})</option>)}
          </select>
        </label>
        <label className="review-sort">
          <span className="review-sort-label">Sort</span>
          <select
            value={sort}
            onChange={(event) => { setSort(event.target.value as ThreadSort); onActivate(null); }}
            aria-label="Sort discussions"
          >
            <option value="document">Passage order</option>
            <option value="newest">Newest</option>
            <option value="oldest">Oldest</option>
            <option value="blocking">Blocking first</option>
          </select>
        </label>
      </div>, controlsHost)}
      {filtered.length === 0 && (
        <p className="empty">
          {threads.length === 0
            ? 'No comments yet.'
            : query.trim()
              ? `No discussions match “${query.trim()}”.`
              : EMPTY_FILTER_MESSAGES[filter]}
        </p>
      )}
      <div className="thread-list" ref={threadListRef}>
        {listItems}
      </div>
      {commentHint}
    </div>
  );
}

function ThreadCard({
  commentNumber,
  replyDraft,
  onReplyDraftChange,
  thread,
  active,
  viewerNames,
  viewerIdentityKeys,
  canComment,
  canMutateShared,
  mentionCandidates,
  identityProviderLabel,
  searchIdentities,
  onRequestIdentitySignIn,
  onReply,
  onResolve,
  onDelete,
  onActivate,
  onLocateThread,
  buildThreadLink,
  canReact,
  onReact,
  canApplySuggestion,
  suggestionApplyReason,
  onApplySuggestion,
  onDismissSuggestion,
  aiSuggestEnabled,
  aiDrafting,
  onDraftAiSuggestion,
}: {
  commentNumber: number;
  replyDraft: ReplyDraft;
  onReplyDraftChange: (draft: ReplyDraft) => void;
  thread: Thread;
  active: boolean;
  viewerNames: string[];
  viewerIdentityKeys: string[];
  canComment: boolean;
  canMutateShared: boolean;
  mentionCandidates: MentionCandidate[];
  identityProviderLabel: string;
  searchIdentities: (term: string, signal: AbortSignal) => Promise<IdentitySearchOutcome>;
  onRequestIdentitySignIn: (authority: 'github' | 'microsoft') => Promise<void>;
  onReply: (id: string, body: string, mentions: MentionReference[]) => boolean;
  onResolve: (id: string, resolved: boolean) => void;
  onDelete: (id: string) => void;
  onActivate: (id: string | null) => void;
  onLocateThread: (id: string) => void;
  buildThreadLink: (threadId: string) => string;
  canReact: boolean;
  onReact: (threadId: string, commentId: string, emoji: ReactionEmoji) => void;
  canApplySuggestion: boolean;
  suggestionApplyReason?: string;
  onApplySuggestion: (threadId: string) => void;
  onDismissSuggestion: (threadId: string) => void;
  aiSuggestEnabled: boolean;
  aiDrafting: boolean;
  onDraftAiSuggestion: (threadId: string) => void;
}) {
  const reply = replyDraft.body;
  const replyMentions = replyDraft.mentions;
  const [replyOpen, setReplyOpen] = useState(Boolean(reply));
  const [linkCopied, setLinkCopied] = useState(false);
  const [linkFallback, setLinkFallback] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuStartAtEnd = useRef(false);
  const menuId = `thread-actions-${thread.id}`;
  const orphan = thread.located === false;
  const unsure = thread.confidence === 'needs-confirmation';
  const intent = threadIntent(thread);
  const IntentIcon = INTENT_ICONS[intent];
  const waitingOnDetails = deriveWaitingOnIdentities(thread);
  const verifiedWaitingOn = waitingOnDetails
    .filter((identity) => identity.identityKeys.length > 0)
    .map((identity) => identity.handle);
  const unresolvedWaitingOn = waitingOnDetails
    .filter((identity) => identity.identityKeys.length === 0)
    .map((identity) => identity.handle);
  const waitingOnViewer = isWaitingOnViewer(thread, viewerNames, viewerIdentityKeys);
  const canDiscard = canMutateShared || thread.comments.every((comment) => comment.localOnly);

  const closeMenu = () => {
    setMenuOpen(false);
    menuButtonRef.current?.focus({ preventScroll: true });
  };

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    const button = menuButtonRef.current;
    if (!menu || !button) return;
    const position = () => {
      const anchor = button.getBoundingClientRect();
      const scale = menu.getBoundingClientRect().width / menu.offsetWidth;
      menu.style.maxWidth = `${(window.innerWidth - 16) / scale}px`;
      menu.style.maxHeight = `${(window.innerHeight - 16) / scale}px`;
      const bounds = menu.getBoundingClientRect();
      const below = anchor.bottom + 6;
      const top = below + bounds.height <= window.innerHeight - 8 ? below : anchor.top - bounds.height - 6;
      menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - bounds.height - 8)) / scale}px`;
      menu.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, window.innerWidth - bounds.width - 8)) / scale}px`;
    };
    position();
    const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    items[menuStartAtEnd.current ? items.length - 1 : 0]?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !button.contains(event.target as Node)) setMenuOpen(false);
    };
    const resize = new ResizeObserver(position);
    resize.observe(menu);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    document.addEventListener('pointerdown', outside);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      document.removeEventListener('pointerdown', outside);
    };
  }, [menuOpen]);

  const cls = ['thread', `intent-${intent}`];
  if (active) cls.push('active');
  if (thread.resolved) cls.push('resolved');
  if (orphan) cls.push('orphan');

  return (
    <div className={cls.join(' ')} data-review-thread={thread.id} data-review-slot={thread.id} role="group" aria-label={`Comment ${commentNumber}${thread.resolved ? ', resolved' : ''}`} tabIndex={-1} onClick={() => onActivate(thread.id)}>
      <button type="button" className="quote" title={thread.anchor.quote} aria-label={`Show passage for comment ${commentNumber}`} disabled={orphan} onClick={event => { event.stopPropagation(); onLocateThread(thread.id); }}>
        <span className="comment-number" aria-hidden="true">{commentNumber}</span>
        <span className="quote-text">“{thread.anchor.quote}”</span>
      </button>
      <div className="thread-labels">
        <span className={`intent-badge intent-${intent}`}><IntentIcon size={14} aria-hidden="true" />{INTENT_LABELS[intent]}</span>
        {thread.resolved && <span className="thread-resolution"><Check size={14} aria-hidden="true" />Resolved</span>}
        <button
          type="button"
          className="thread-menu-trigger"
          ref={menuButtonRef}
          aria-label={`More actions for comment ${commentNumber}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
          title={linkCopied ? 'Link copied' : 'More actions'}
          onClick={event => { event.stopPropagation(); menuStartAtEnd.current = false; setMenuOpen(open => !open); }}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            event.stopPropagation();
            menuStartAtEnd.current = event.key === 'ArrowUp';
            setMenuOpen(true);
          }}
        >{linkCopied ? <Check size={16} aria-hidden="true" /> : <EllipsisVertical size={16} aria-hidden="true" />}</button>
        {!thread.resolved && verifiedWaitingOn.length > 0 && (
          <span
            className={`waiting-badge${waitingOnViewer ? ' mine' : ''}`}
            title={`Waiting on ${verifiedWaitingOn.map((login) => `@${login}`).join(', ')}`}
          >
            <AtSign size={14} aria-hidden="true" /><span className="waiting-label">Waiting on</span>
            <span className="waiting-aliases">{verifiedWaitingOn.map((login) => `@${login}`).join(', ')}</span>
          </span>
        )}
        {!thread.resolved && unresolvedWaitingOn.length > 0 && (
          <span
            className="waiting-badge unresolved"
            title={UNVERIFIED_ALIAS_TITLE}
          >
            <CircleAlert size={14} aria-hidden="true" /><span className="waiting-label">Unverified</span>
            <span className="waiting-aliases">{unresolvedWaitingOn.map((login) => `@${login}`).join(', ')}</span>
          </span>
        )}
      </div>
      {orphan && (
        <div className="badge orphan" style={{ marginBottom: 6, display: 'inline-block' }}>
          ⚠ text changed — couldn’t re-locate
        </div>
      )}
      {unsure && !orphan && (
        <div className="badge unsure" style={{ marginBottom: 6, display: 'inline-block' }}>
          ⚠ text changed — check this is still the right place
        </div>
      )}
      {thread.suggestion && (
        <div className="suggestion" onClick={(event) => event.stopPropagation()}>
          <div className="suggestion-head">
            <span className="suggestion-label">
              {(() => {
                const ai = thread.suggestion.origin === 'ai';
                const applied = isSuggestionApplied(thread.suggestion);
                const kind = ai ? 'AI-suggested change' : 'Suggested change';
                return applied ? `${kind} applied to draft` : kind;
              })()}
            </span>
            {thread.suggestion.skillName && (
              <span className="review-policy-badge">skill: {thread.suggestion.skillName}</span>
            )}
          </div>
          <div className="suggestion-diff" aria-label="Proposed change">
            {diffLines(thread.anchor.quote, thread.suggestion.replacement).map((line, index) => (
              <div key={index} className={`diff-line ${line.kind}`}>
                <span className="diff-sign" aria-hidden>
                  {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                </span>
                <span className="diff-text">{line.text || '\u00a0'}</span>
              </div>
            ))}
          </div>
          {!isSuggestionApplied(thread.suggestion) && (
            <div className="suggestion-actions">
              <button
                type="button"
                className="primary"
                disabled={!canApplySuggestion}
                title={
                  canApplySuggestion
                    ? 'Apply to the document draft and resolve the thread'
                    : suggestionApplyReason
                }
                onClick={(event) => {
                  event.stopPropagation();
                  onApplySuggestion(thread.id);
                }}
              >
                Apply to draft
              </button>
              <button
                type="button"
                disabled={!canMutateShared}
                title={canMutateShared ? 'Dismiss this suggestion; keep the thread open' : 'Sign in to change a shared thread'}
                onClick={(event) => {
                  event.stopPropagation();
                  onDismissSuggestion(thread.id);
                }}
              >
                Dismiss
              </button>
            </div>
          )}
          {!canApplySuggestion && !isSuggestionApplied(thread.suggestion) && suggestionApplyReason && (
            <p className="review-summary-note">{suggestionApplyReason}</p>
          )}
        </div>
      )}
      {thread.comments.map((c) => (
        <div className="comment" key={c.id}>
          <div className="comment-head">
            <div className="meta">
              {c.author} · {new Date(c.createdAt).toLocaleString()}
              {c.localOnly && <span className="local-feedback-label">Local feedback</span>}
            </div>
            <ReactionAdd
              comment={c}
              canReact={canReact}
              viewerIdentityKeys={viewerIdentityKeys}
              onReact={(emoji) => onReact(thread.id, c.id, emoji)}
            />
          </div>
          <div className="body">{renderBody(c)}</div>
          <ReactionCounts
            comment={c}
            canReact={canReact}
            viewerIdentityKeys={viewerIdentityKeys}
            onReact={(emoji) => onReact(thread.id, c.id, emoji)}
          />
        </div>
      ))}
      {replyOpen && <div className="thread-reply">
      <MentionEditor
        autoFocus
        placeholder={canComment ? 'Reply…' : 'Checking identity…'}
        value={reply}
        mentions={replyMentions}
        localCandidates={mentionCandidates}
        providerLabel={identityProviderLabel}
        search={searchIdentities}
        onRequestSignIn={onRequestIdentitySignIn}
        disabled={!canComment}
        onClick={(event) => event.stopPropagation()}
        onChange={(value, mentions) => {
          onReplyDraftChange({ body: value, mentions });
        }}
      />
      <div className="actions">
        <button className="primary" disabled={!canComment || !reply.trim()} onClick={(event) => {
          event.stopPropagation();
          if (onReply(thread.id, reply, replyMentions)) { onReplyDraftChange({ body: '', mentions: [] }); setReplyOpen(false); }
        }}>Post reply</button>
        <button onClick={(event) => {
          event.stopPropagation();
          if (reply.trim() && !window.confirm('Discard this unsent reply?')) return;
          onReplyDraftChange({ body: '', mentions: [] });
          setReplyOpen(false);
        }}>Cancel</button>
      </div>
      </div>}
      <div className="actions thread-primary-actions">
        <button
          type="button"
          className="thread-reply-action"
          disabled={!canComment}
          onClick={(e) => {
            e.stopPropagation();
            setReplyOpen(true);
          }}
        >
          <Reply size={14} aria-hidden="true" /><span>Reply</span>
        </button>
        <button
          type="button"
          disabled={!canMutateShared}
          title={canMutateShared ? undefined : 'Sign in to change shared thread status'}
          onClick={(e) => {
            e.stopPropagation();
            onResolve(thread.id, !thread.resolved);
          }}
        >
          {thread.resolved ? <RotateCcw size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          <span>{thread.resolved ? 'Reopen' : 'Resolve'}</span>
        </button>
        <button type="button" disabled={orphan} title={orphan ? 'The original passage could not be located' : undefined} onClick={(event) => { event.stopPropagation(); onLocateThread(thread.id); }}>
          <TextSearch size={14} aria-hidden="true" /><span>Show passage</span>
        </button>
      </div>
      <span className="thread-action-status" role="status">{linkCopied ? 'Link copied' : ''}</span>
      {menuOpen && createPortal(
        <div
          id={menuId}
          className="thread-action-menu"
          role="menu"
          aria-label={`Actions for comment ${commentNumber}`}
          ref={menuRef}
          onClick={event => event.stopPropagation()}
          onKeyDown={event => {
            event.stopPropagation();
            if (event.key === 'Escape' || event.key === 'Tab') {
              if (event.key === 'Escape') event.preventDefault();
              closeMenu();
              return;
            }
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
            items[next]?.focus({ preventScroll: true });
          }}
        >
          <button type="button" role="menuitem" tabIndex={-1} onClick={async () => {
            closeMenu();
            try {
              await navigator.clipboard.writeText(buildThreadLink(thread.id));
              setLinkCopied(true);
              window.setTimeout(() => setLinkCopied(false), 1500);
            } catch {
              setLinkFallback(true);
            }
          }}><Copy size={15} aria-hidden="true" />Copy link</button>
          {!thread.suggestion && !thread.resolved && thread.comments.length > 0 && aiSuggestEnabled && (
            <button type="button" role="menuitem" tabIndex={-1} disabled={aiDrafting} onClick={() => { closeMenu(); onDraftAiSuggestion(thread.id); }}>
              <Sparkles size={15} aria-hidden="true" />{aiDrafting ? 'Drafting...' : 'AI: draft a fix'}
            </button>
          )}
          <button type="button" role="menuitem" tabIndex={-1} className="danger" disabled={!canDiscard} title={canDiscard ? undefined : 'Sign in to delete a shared thread'} onClick={() => {
            closeMenu();
            if (window.confirm('Delete this comment thread and its replies?')) onDelete(thread.id);
          }}>
            <Trash2 size={15} aria-hidden="true" />Delete
          </button>
        </div>, document.body
      )}
      {linkFallback && (
        <Dialog labelledBy={`copy-thread-${thread.id}`} onClose={() => setLinkFallback(false)} returnFocusTo={menuButtonRef.current}>
          <h3 id={`copy-thread-${thread.id}`}>Copy thread link</h3>
          <p role="status">Clipboard unavailable. Select and copy the link below.</p>
          <input className="share-link-input" aria-label="Thread link" readOnly value={buildThreadLink(thread.id)} onFocus={(event) => event.currentTarget.select()} />
          <div className="modal-actions"><button onClick={() => setLinkFallback(false)}>Close</button></div>
        </Dialog>
      )}
    </div>
  );
}

function ReactionCounts({
  comment,
  canReact,
  viewerIdentityKeys,
  onReact,
}: {
  comment: Comment;
  canReact: boolean;
  viewerIdentityKeys: string[];
  onReact: (emoji: ReactionEmoji) => void;
}) {
  const tallies = tallyReactions(comment.reactions, viewerIdentityKeys);
  if (tallies.length === 0) return null;
  return (
    <div className="reactions" onClick={(event) => event.stopPropagation()}>
      {tallies.map((tally) => {
        const mine = tally.reactedByViewer;
        return (
          <button
            key={tally.emoji}
            type="button"
            className={`reaction${mine ? ' mine' : ''}`}
            disabled={!canReact}
            aria-pressed={mine}
            aria-label={`${mine ? 'Remove' : 'Add'} ${tally.emoji} reaction`}
            title={!canReact ? 'Sign in to react' : `${tally.emoji} ${tally.names.join(', ')}`}
            onClick={(event) => {
              event.stopPropagation();
              onReact(tally.emoji);
            }}
          >
            <span className="reaction-emoji">{tally.emoji}</span>
            <span className="reaction-count">{tally.count}</span>
          </button>
        );
      })}
    </div>
  );
}

// The "add reaction" affordance sits at the comment's top-right (by the meta
// line). Its face icon is grayed until hovered/open so it never looks like a
// reaction the viewer already made. Opens the full palette on demand.
function ReactionAdd({
  comment,
  canReact,
  viewerIdentityKeys,
  onReact,
}: {
  comment: Comment;
  canReact: boolean;
  viewerIdentityKeys: string[];
  onReact: (emoji: ReactionEmoji) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const byEmoji = new Map(
    tallyReactions(comment.reactions, viewerIdentityKeys).map((tally) => [tally.emoji, tally])
  );

  useEffect(() => {
    if (!open) return;
    const onDocClick = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // When the viewer has no identity to react with (e.g. signed out on the
  // sample), keep the affordance visible but disabled with a "Sign in to react"
  // tooltip — mirroring ReactionCounts and the other gated controls — instead of
  // hiding it, so the feature stays discoverable (issue #104).
  return (
    <div className="reaction-add-wrap" ref={rootRef} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        className={`reaction-add${open ? ' open' : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-label={canReact ? 'Add a reaction' : 'Sign in to react'}
        title={canReact ? 'Add a reaction' : 'Sign in to react'}
        disabled={!canReact}
        onClick={(event) => {
          event.stopPropagation();
          if (!canReact) return;
          setOpen((value) => !value);
        }}
      >
        <span className="reaction-add-face" aria-hidden>
          🙂
        </span>
        <span className="reaction-add-plus" aria-hidden>
          +
        </span>
      </button>
      {open && (
        <div className="reaction-picker" role="menu">
          {REACTION_EMOJIS.map((emoji) => {
            const mine = byEmoji.get(emoji)?.reactedByViewer ?? false;
            return (
              <button
                key={emoji}
                type="button"
                className={`reaction-choice${mine ? ' mine' : ''}`}
                aria-pressed={mine}
                aria-label={`${mine ? 'Remove' : 'Add'} ${emoji} reaction`}
                title={emoji}
                onClick={(event) => {
                  event.stopPropagation();
                  onReact(emoji);
                  setOpen(false);
                }}
              >
                {emoji}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
