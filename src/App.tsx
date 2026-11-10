import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import { createPortal } from 'react-dom';
import remarkGfm from 'remark-gfm';
import type {
  AnchorConfidence,
  Anchor,
  Comment,
  DocThreadFile,
  DocThreadFileV1,
  DocThreadFileV2,
  MentionReference,
  NotificationDispatch,
  Thread,
  ThreadIntent,
} from './types';
import { buildTextMap, createAnchor, locateAnchor, locateInText } from './anchor';
import { applyCommand, type ToolbarCommand } from './markdownToolbar';
import { applySuggestion } from './suggestion';
import { applyHtmlSuggestion } from './htmlSuggestion';
import { buildSuggestionRequest, requestAiSuggestion } from './aiSuggest';
import type { ReadinessGap } from './readiness';
import type { ReviewFinding } from './aiReview';
import type { FindingAcceptanceOutcome } from './reviewSessionInsights';
import { parseReviewPolicy, DEFAULT_POLICY, type ReviewPolicy } from './reviewPolicy';
import {
  isHttpUrl,
  parseSkillPaths,
  resolveSkillFromText,
  type SkillSource,
} from './aiSkill';
import { CommentGutter } from './components/CommentGutter';
import { MentionEditor, type IdentitySearchOutcome } from './components/MentionEditor';
import { SAMPLE_DOC, SAMPLE_THREADS, SAMPLE_VERSION } from './sample';
import {
  loadLocal,
  notifyMentions,
  saveLocal,
  fetchMarkdown,
} from './github';
import {
  parseAdoWorkItemUrl,
  parseAzureReposUrl,
  type SourceTarget,
} from './source';
import {
  mentionCandidates,
  finalizeMentionReferences,
  mentionStyleFor,
  mentionStyleHint,
} from './mentions';
import {
  durableIdentityHandle,
  identityDisplayName,
  joinGraphMailToGitHubCollaborators,
  rankIdentityCandidates,
  githubGraphqlUrl,
  searchGitHubCollaborators,
  searchGraphUsers,
  verifyGitHubNotificationRecipients,
} from './identity';
import {
  decodeGitHubTargetDeepLinkParams,
  executePublicGitHubResolutionRequest,
  resolveGitHubSourceUrl,
  verifyGitHubSourceTarget,
  type GitHubGraphQLRequest,
  type VerifiedGitHubSourceTarget,
} from './githubSource';
import {
  assertImmutableCommentAccepted,
  findComment,
  pendingGitHubDispatch,
  transitionCommentDispatch,
} from './notification';
import { attributeLocalComments, mergeDocThreadFiles } from './reviewPersistence';
import { ProviderError } from './providerError';
import {
  commitSourceDocument,
  createSourceDocumentPullRequest,
  fetchSourceDocument,
  loadSourceSidecar,
  loadAdoReview,
  saveAdoReview,
  getAdoReviewStoreMode,
  setAdoReviewStoreMode,
  resolveSourceTarget,
  saveSourceSidecar,
  sourceAccessConfigured,
  sourceDocumentLabel,
  sourceFileUrl,
  sourceIsWritable,
  sourceProviderName,
  sourceReferenceLabel,
  sourceRepositoryLabel,
  sourceStorageKey,
  sourceSupportsPullRequest,
  sourceDeepLink,
  type LoadedSourceSidecar,
} from './providers';
import { ADO_REVIEW_STORE_MODES, type AdoReviewStoreMode } from './ado';
import { mentionContact } from './mentionContacts';
import { readThreadParam, withThreadParam } from './threadLink';
import { toggleReaction, adoReactionIdentityKey, type ReactionEmoji } from './reactions';
import { sendMentionEmail, buildMentionEmail, collectMentionEmailTargets } from './notifyEmail';
import { buildTeamsMessage, sendTeamsNotification } from './notifyTeams';
import {
  parseInviteEmails,
  partitionInviteEmails,
  makeInvite,
  mergeInvites,
  deriveParticipation,
  buildShareInviteEmail,
  loadInvites,
  storeInvites,
  type Invite,
} from './shareReview';
import { RecentsPanel } from './components/RecentsPanel';
import { NotificationBell } from './components/NotificationBell';
import { ShareModal } from './components/ShareModal';
import { Dialog } from './components/Dialog';
import { acceptFeedbackOutcome, captureReviewOperation, feedbackMessage, hasUnsentInput, isCurrentReviewOperation, leaveSourceReason, type FeedbackNotice, type ReplyDraft } from './reviewUi';
import { clearDocumentDraft, combineAdoReviewCopies, loadAdoLocalReview, loadDocumentDraft, sameReviewThreads, storeDocumentDraft } from './reviewRecovery';
import { loadSpellCheckPref, storeSpellCheckPref, loadEditorViewMode, storeEditorViewMode, type EditorViewMode } from './editorPrefs';
import {
  buildInbox,
  loadInboxReadState,
  storeInboxReadState,
  markItemRead,
  markAllRead,
  type InboxItem,
  type InboxReadState,
} from './inbox';
import {
  loadRecents,
  storeRecents,
  promoteRecent,
  loadRecentsCollapsed,
  storeRecentsCollapsed,
  type RecentEntry,
} from './recents';
import {
  assignGitHubReviewIssueReviewers,
  buildGitHubRequestPreview,
  createGitHubReviewIssue,
  defaultRequestReviewDraft,
  findActiveGitHubIssueDuplicate,
  formatReviewRequestStatus,
  loadReviewRequestRecords,
  makeGitHubReviewRecord,
  makeUnknownGitHubIssueRecord,
  mergeReviewRequestRecords,
  mapGitHubIssueStatus,
  normalizeRequestReviewDraftChannel,
  parseReviewerHandles,
  reconcileUnknownGitHubReviewIssue,
  requestReviewDraftStorageKey,
  requestReviewEligibility,
  RequestReviewProviderError,
  refreshGitHubReviewIssueStatus,
  storeReviewRequestRecords,
  upsertReviewRequestRecord,
  validateGitHubRequestPreview,
  type RequestReviewPreview,
  type ReviewRequestDraft,
  type ReviewRequestRecord,
} from './requestReview';
import {
  AUTH_MODE,
  GH_API_BASE,
  NOTIFY_ENDPOINT,
  NOTIFY_ALLOWED_DOMAINS,
  SUMMARIZE_ENDPOINT,
  SUGGEST_ENDPOINT,
  READINESS_ENDPOINT,
  REVIEW_ENDPOINT,
  SKILL_PATHS,
  TEAMS_NOTIFY_ENABLED,
  getAuthStatus,
  getToken,
  signOut as signOut_,
  startDevLogin,
  startDeviceLogin,
  pollForDeviceToken,
  type DeviceCode,
} from './auth';
import {
  AZURE_AUTH_MODE,
  GRAPH_TRANSPORT,
  MICROSOFT_TENANT_ID,
  getAzureAuthStatus,
  getGraphAccessToken,
  signOutAzure,
  startGraphLogin,
  startAzureLogin,
} from './azureAuth';

const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();

type DocumentFormat = 'markdown' | 'html';

function isHtmlDocumentPath(path: string): boolean {
  return /\.(?:html?|xhtml)$/i.test(path);
}

function documentFormatForSource(target: SourceTarget | null): DocumentFormat {
  if (!target || target.kind === 'ado-workitem') return 'markdown';
  return isHtmlDocumentPath(target.path) ? 'html' : 'markdown';
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sanitizeHtml(value: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(value || '', 'text/html');
  doc.querySelectorAll('script, iframe, object, embed').forEach((node) => {
    node.remove();
  });
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_ELEMENT);
  const urlAttrs = new Set(['href', 'src', 'xlink:href']);
  while (walker.nextNode()) {
    const el = walker.currentNode as HTMLElement;
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (urlAttrs.has(name) && /^(?:javascript|data):/i.test(value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc.documentElement.outerHTML;
}

function buildHtmlSrcDoc(value: string, baseHref?: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(value || '', 'text/html');
  const style = doc.createElement('style');
  style.setAttribute('data-docthread-highlight-style', 'true');
  style.textContent = `
    .dt-highlight { background: #fff8c5; border-bottom: 2px solid #f7c843; cursor: pointer; border-radius: 2px; }
    .dt-highlight.active { background: #f7c843; }
    .dt-highlight.fuzzy { background: #fff1a8; }
    .dt-highlight.resolved { background: #dafbe1; border-bottom-color: #92c47d; }
    .dt-highlight.unsure { background: #fff1a8; border-bottom: 2px dashed #d9a441; }
    .dt-highlight.multi { background: #ffe08a; box-shadow: inset 0 -2px 0 rgba(0,0,0,0.12); }
    .dt-highlight.paired:not(.active) { background: rgba(9, 105, 218, 0.12); border-bottom-color: #0969da; }
    .dt-highlight.active { outline-color: #0969da; }
    ::highlight(compose-anchor) { background-color: rgba(9, 105, 218, 0.22); color: inherit; }
    ::highlight(finding-flash) { background-color: rgba(191, 135, 0, 0.35); color: inherit; }
  `;
  doc.head.appendChild(style);
  if (baseHref) {
    const base = doc.querySelector('base') ?? doc.createElement('base');
    base.setAttribute('href', baseHref);
    if (!base.isConnected) doc.head.prepend(base);
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

function documentTextForReview(value: string, format: DocumentFormat): string {
  if (format !== 'html') return value;
  const parser = new DOMParser();
  const doc = parser.parseFromString(sanitizeHtml(value), 'text/html');
  return doc.body.textContent ?? '';
}

function documentTitleFor(value: string, format: DocumentFormat): string | undefined {
  if (!value.trim()) return undefined;
  if (format === 'html') {
    const doc = new DOMParser().parseFromString(value, 'text/html');
    return doc.body.querySelector('h1, h2')?.textContent?.trim() || doc.title?.trim() || undefined;
  }
  return value.match(/^#\s+(.+)$/m)?.[1]?.trim() || undefined;
}

function renderSourceDocumentHtml(value: string, format: DocumentFormat): string {
  return format === 'html'
    ? sanitizeHtml(value)
    : renderToStaticMarkup(<MarkdownDoc text={value} />);
}

function renderEditorBackdropHtml(value: string, format: DocumentFormat): string {
  return format === 'html'
    ? escapeHtmlText(value).replace(/\n/g, '<br />')
    : renderToStaticMarkup(<MarkdownDoc text={value} />);
}

async function executeGitHubGraphQL(request: GitHubGraphQLRequest): Promise<unknown> {
  const token = getToken();
  if (AUTH_MODE === 'static' && !token) {
    return executePublicGitHubResolutionRequest(request);
  }
  const response = await fetch(githubGraphqlUrl(GH_API_BASE), {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query: request.query, variables: request.variables }),
    signal: request.signal,
  });
  if (!response.ok) {
    throw new Error(`GitHub source resolution failed (${response.status}).`);
  }
  return response.json();
}
function reviewFile(
  docPath: string,
  threads: Thread[],
  target: SourceTarget | null,
  markdown: string
): DocThreadFile {
  const persistedThreads = threads.map(({ located: _located, confidence: _confidence, ...thread }) =>
    thread
  );
  if (target && target.kind !== 'ado-workitem') {
    return {
      schemaVersion: 2,
      source: { provider: target.kind, path: target.path },
      docPath: target.path,
      threads: persistedThreads,
      updatedAt: now(),
    };
  }
  if (!target) {
    return { schemaVersion: 1, docPath, threads: persistedThreads, updatedAt: now() };
  }
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return {
    schemaVersion: 1,
    docPath,
    threads: persistedThreads,
    markdown,
    meta: {
      source: 'ado-workitem',
      title,
      sourceUrl: sourceFileUrl(target),
    },
    updatedAt: now(),
  };
}

const SAMPLE_VERSION_KEY = 'docthread:sample:version';

// Load the example review for the built-in sample. A persisted sample review is
// reused only when it was saved against the current sample version; otherwise the
// freshly authored SAMPLE_THREADS are used so every example anchors cleanly to the
// latest sample text instead of surfacing as "text changed" orphans after a rewrite.
function loadSampleThreads(): Thread[] {
  try {
    if (localStorage.getItem(SAMPLE_VERSION_KEY) === SAMPLE_VERSION) {
      const persisted = loadLocal('sample');
      if (persisted?.threads?.length) return persisted.threads;
    }
  } catch {
    /* ignore storage errors; fall back to the authored sample */
  }
  return SAMPLE_THREADS;
}

const THREAD_INTENTS: { value: ThreadIntent; label: string }[] = [
  { value: 'question', label: 'Question' },
  { value: 'suggestion', label: 'Suggestion' },
  { value: 'blocking', label: 'Blocking' },
];

interface FlatRange {
  start: number;
  end: number;
  ids: string[];
  classes: string[];
}

interface InputRange {
  start: number;
  end: number;
  id: string;
  classes: string[];
}

/**
 * Turn possibly-overlapping ranges into disjoint intervals, unioning the ids
 * and classes of every range covering each interval.
 */
function flattenRanges(ranges: InputRange[], len: number): FlatRange[] {
  if (ranges.length === 0) return [];
  if (ranges.length === 1) {
    const r = ranges[0];
    const start = Math.max(0, Math.min(r.start, len));
    const end = Math.max(start, Math.min(r.end, len));
    return end > start ? [{ start, end, ids: [r.id], classes: r.classes }] : [];
  }

  const bounds = new Set<number>();
  for (const r of ranges) {
    bounds.add(Math.max(0, Math.min(r.start, len)));
    bounds.add(Math.max(0, Math.min(r.end, len)));
  }
  const points = [...bounds].sort((a, b) => a - b);

  const out: FlatRange[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i];
    const end = points[i + 1];
    if (end <= start) continue;

    const covering = ranges.filter((r) => r.start <= start && r.end >= end);
    if (covering.length === 0) continue;

    const ids = covering.map((r) => r.id);
    const classes = new Set<string>();
    for (const r of covering) for (const c of r.classes) classes.add(c);
    if (covering.length > 1) classes.add('multi');

    out.push({ start, end, ids, classes: [...classes] });
  }

  const merged: FlatRange[] = [];
  for (const seg of out) {
    const prev = merged[merged.length - 1];
    const sameOwners =
      prev &&
      prev.end === seg.start &&
      prev.ids.length === seg.ids.length &&
      prev.ids.every((id) => seg.ids.includes(id));
    if (sameOwners) prev.end = seg.end;
    else merged.push(seg);
  }
  return merged;
}

interface SourceInputDraft {
  selection: { x: number; y: number; anchor: Anchor } | null;
  comment: string;
  mentions: MentionReference[];
  intent: ThreadIntent;
  suggest: boolean;
  replacement: string;
  replies: Record<string, ReplyDraft>;
  document?: string;
}

export default function App() {
  const [docPath, setDocPath] = useState('sample');
  const [markdown, setMarkdown] = useState(SAMPLE_DOC);
  const [documentFormat, setDocumentFormat] = useState<DocumentFormat>('markdown');
  const [htmlFrameLoadCount, setHtmlFrameLoadCount] = useState(0);
  const [htmlFrameHeight, setHtmlFrameHeight] = useState(0);
  const [htmlFrameScale, setHtmlFrameScale] = useState(1);
  const [threads, setThreads] = useState<Thread[]>(
    () => loadSampleThreads()
  );
  const visibleThreads = useMemo(() => threads.filter((thread) => !thread.deletedAt), [threads]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [threadFocusRequest, setThreadFocusRequest] = useState<{ id: string } | null>(null);
  const selectionClick = useRef(false);
  const focusDiscussion = (id: string) => { setActiveId(id); setThreadFocusRequest({ id }); };
  const [editing, setEditing] = useState(false);
  const [draftMd, setDraftMd] = useState('');
  const [orphanCount, setOrphanCount] = useState(0);
  const [recents, setRecents] = useState<RecentEntry[]>(() => loadRecents());
  const [recentsCollapsed, setRecentsCollapsed] = useState<boolean>(() =>
    loadRecentsCollapsed(false)
  );

  // "Share for review" (#111): locally-stored invites (keyed by canonical source
  // identity, so the review sidecar schema is untouched) and the dialog state.
  const [invites, setInvites] = useState<Invite[]>([]);
  const [shareOpen, setShareOpen] = useState(false);
  const [requestReviewOpen, setRequestReviewOpen] = useState(false);
  const [requestReviewPreview, setRequestReviewPreview] = useState<RequestReviewPreview | null>(null);
  const [requestReviewDraft, setRequestReviewDraft] = useState<ReviewRequestDraft>(() =>
    defaultRequestReviewDraft(null, undefined, now())
  );
  const [reviewRequests, setReviewRequests] = useState<ReviewRequestRecord[]>([]);
  const [requestReviewError, setRequestReviewError] = useState('');
  const autoRefreshedReviewRequests = useRef(new Set<string>());
  const reviewRequestMemory = useRef(new Map<string, ReviewRequestRecord[]>());
  const reviewDraftMemory = useRef(new Map<string, ReviewRequestDraft>());
  const reviewStorageWarnings = useRef(new Map<string, string>());
  const reviewRequestScope = useRef({ sourceKey: '', account: '' });
  const reviewPreviewScope = useRef(reviewRequestScope.current);
  const reviewSubmitLock = useRef(false);
  const reviewRefreshVersions = useRef(new Map<string, object>());
  const [requestReviewBusy, setRequestReviewBusy] = useState(false);
  const [reviewDraftSourceKey, setReviewDraftSourceKey] = useState('');
  const [showHiddenReviews, setShowHiddenReviews] = useState(false);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false);
  const [toolsHost, setToolsHost] = useState<HTMLDivElement | null>(null);
  const [composerHost, setComposerHost] = useState<HTMLDivElement | null>(null);
  const [reviewControlsHost, setReviewControlsHost] = useState<HTMLDivElement | null>(null);
  const [commentHintDismissed, setCommentHintDismissed] = useState(false);
  const feedbackVersion = useRef(0);
  const [feedbackNotice, setFeedbackNotice] = useState<FeedbackNotice>({ sourceKey: 'sample', version: 0, phase: 'local' });
  const [notificationNotice, setNotificationNotice] = useState<{ sourceKey: string; text: string } | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, ReplyDraft>>({});
  const [savedDraftMd, setSavedDraftMd] = useState(SAMPLE_DOC);
  const pendingOperations = useRef(0);
  const [operationCount, setOperationCount] = useState(0);
  const [sourceLoading, setSourceLoading] = useState(false);
  const [sourceProblem, setSourceProblem] = useState('');
  const [sourceReceipt, setSourceReceipt] = useState<{ sourceKey: string; text: string; url?: string } | null>(null);
  const [localSaveError, setLocalSaveError] = useState('');
  const [pendingLeave, setPendingLeave] = useState<{ run: () => void; reason: 'draft' | 'feedback' } | null>(null);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const sourceInputs = useRef(new Map<string, SourceInputDraft>());
  const [recoveredDocument, setRecoveredDocument] = useState<{ sourceKey: string; markdown: string } | null>(null);
  const [documentRecoveryOpen, setDocumentRecoveryOpen] = useState(false);
  const [storedDocumentDraft, setStoredDocumentDraft] = useState<{ sourceKey: string; markdown: string } | null>(null);
  const [documentDraftProblem, setDocumentDraftProblem] = useState<{ sourceKey: string; text: string } | null>(null);
  const [adoRecovery, setAdoRecovery] = useState<{ sourceKey: string; local: DocThreadFileV1; shared: DocThreadFileV1 } | null>(null);
  const [adoRecoveryOpen, setAdoRecoveryOpen] = useState(false);
  const [adoRecoveryError, setAdoRecoveryError] = useState('');
  const [adoReadError, setAdoReadError] = useState('');

  const beginOperation = () => {
    pendingOperations.current += 1;
    setOperationCount(pendingOperations.current);
    return () => {
      pendingOperations.current -= 1;
      setOperationCount(pendingOperations.current);
    };
  };

  // Compose popup state.
  const [compose, setCompose] = useState<{ x: number; y: number; anchor: Thread['anchor'] } | null>(
    null
  );
  const [composeText, setComposeText] = useState('');
  // Spell-check the in-place editor (#62). On by default; persisted so authors of
  // code-heavy docs can silence the squiggle storm.
  const [spellCheckOn, setSpellCheckOn] = useState<boolean>(() => loadSpellCheckPref());
  const toggleSpellCheck = () => {
    setSpellCheckOn((on) => {
      const next = !on;
      storeSpellCheckPref(next);
      return next;
    });
  };
  // Edit-mode view: Editor / Split / Preview (#38). Persisted; 'editor' by default
  // so existing behavior is unchanged until the author opts into a preview.
  const [editorView, setEditorView] = useState<EditorViewMode>(() => loadEditorViewMode());
  const chooseEditorView = (mode: EditorViewMode) => {
    setEditorView(mode);
    storeEditorViewMode(mode);
  };
  const previewRef = useRef<HTMLDivElement>(null);
  const syncPreviewScroll = (ratio: number) => {
    const el = previewRef.current;
    if (!el) return;
    const denom = el.scrollHeight - el.clientHeight;
    el.scrollTop = ratio * (denom > 0 ? denom : 0);
  };
  const [composeMentions, setComposeMentions] = useState<MentionReference[]>([]);
  const [composeIntent, setComposeIntent] = useState<ThreadIntent>('question');
  // Suggest-edit mode (#35): capture a proposed replacement for the selected text.
  const [composeSuggest, setComposeSuggest] = useState(false);
  const [composeReplacement, setComposeReplacement] = useState('');

  // Git repository connection.
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceTarget, setSourceTarget] = useState<SourceTarget | null>(null);
  const [githubSourceChoices, setGitHubSourceChoices] = useState<
    readonly VerifiedGitHubSourceTarget[]
  >([]);
  const [pendingMicrosoftSource, setPendingMicrosoftSource] = useState<SourceTarget | null>(null);
  const [sidecarRevision, setSidecarRevision] = useState<string | null>(null);
  const [documentRevision, setDocumentRevision] = useState<string | null>(null);
  const [saveChoice, setSaveChoice] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [attributionDismissed, setAttributionDismissed] = useState(false);

  // GitHub sign-in. Azure Repos identity is tracked separately and shown when
  // the active document comes from Azure Repos.
  const [ghUser, setGhUser] = useState<{
    login: string;
    name?: string;
    nodeId?: string;
    avatarUrl?: string;
  } | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [devLoginStarted, setDevLoginStarted] = useState(false);
  const [azureUser, setAzureUser] = useState<{
    login: string;
    name?: string;
    objectId?: string;
    tenantId?: string;
  } | null>(null);
  const [azureAuthChecked, setAzureAuthChecked] = useState(false);
  const [azureLoginStarted, setAzureLoginStarted] = useState(false);
  const usingAzure =
    sourceTarget?.kind === 'azure-repos' || sourceTarget?.kind === 'ado-workitem';
  const identityChecked = usingAzure ? azureAuthChecked : authChecked;
  const commentAuthor = usingAzure
    ? identityDisplayName(azureUser?.name, azureUser?.login)
    : identityDisplayName(ghUser?.name, ghUser?.login) || (authChecked ? 'You' : '');
  const commentAuthorLogin = durableIdentityHandle(usingAzure ? azureUser?.login : ghUser?.login);
  const commentAuthorIdentityKeys = usingAzure
    ? azureUser?.objectId && azureUser.tenantId
      ? [`entra:${azureUser.tenantId}:${azureUser.objectId}`]
      : []
    : ghUser?.nodeId
      ? [`github:${ghUser.nodeId}`]
      : [];
  // The provider decides the mention shape: GitHub notifies the account login
  // (alias_tenant on EMU), Azure DevOps notifies the bare Microsoft alias.
  // Inserting the right form removes a silent failure — a wrong shape saves
  // fine and notifies nobody.
  const mentionStyle = mentionStyleFor(sourceTarget);
  // ---- Notification center (#31) ----
  const [inboxRead, setInboxRead] = useState<InboxReadState>(() => loadInboxReadState());
  const inboxIdentityKey = commentAuthorIdentityKeys.join('|');
  const inboxItems = useMemo(
    () => buildInbox(visibleThreads, { identityKeys: commentAuthorIdentityKeys, names: [commentAuthor] }),
    // commentAuthorIdentityKeys is rebuilt each render; key on its joined value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleThreads, inboxIdentityKey, commentAuthor]
  );
  const inboxDisabled = commentAuthorIdentityKeys.length === 0;
  const openInboxItem = (item: InboxItem) => {
    focusDiscussion(item.threadId);
    const next = markItemRead(inboxRead, item.id);
    setInboxRead(next);
    storeInboxReadState(next);
  };
  const markInboxAllRead = () => {
    const next = markAllRead(inboxItems, now());
    setInboxRead(next);
    storeInboxReadState(next);
  };
  // Seed the local picker with the viewer's *login/handle* (e.g. mayast_microsoft),
  // not their display name — a display name like "Maya Stewart" would insert
  // "@maya stewart", which only captures "@maya" and notifies no one. Fall back
  // to the display name only when no durable handle is known.
  const mentionViewer = commentAuthorLogin || commentAuthor;
  const mentionOptions = useMemo(
    () => mentionCandidates(visibleThreads, mentionViewer, mentionStyle),
    [visibleThreads, mentionViewer, mentionStyle]
  );

  const canComment = usingAzure ? Boolean(azureUser) : authChecked;
  // Where an ADO work item's review is stored (attachment / description /
  // discussion). Persisted per-browser; pushed into the providers module so the
  // load/save helpers use the chosen backend.
  const [adoStoreMode, setAdoStoreMode] = useState<AdoReviewStoreMode>(() => {
    try {
      const saved = localStorage.getItem('docthread:ado-review-store');
      if (saved && (ADO_REVIEW_STORE_MODES as string[]).includes(saved)) {
        return saved as AdoReviewStoreMode;
      }
    } catch {
      /* ignore storage failures */
    }
    return getAdoReviewStoreMode();
  });
  useEffect(() => {
    setAdoReviewStoreMode(adoStoreMode);
    try {
      localStorage.setItem('docthread:ado-review-store', adoStoreMode);
    } catch {
      /* ignore storage failures */
    }
  }, [adoStoreMode]);
  const canWriteSource = sourceTarget
    ? sourceIsWritable(sourceTarget) &&
      (sourceTarget.kind === 'github' ? Boolean(ghUser) : Boolean(azureUser))
    : false;
  const canPersistReview = sourceTarget
    ? sourceTarget.kind === 'ado-workitem'
      ? Boolean(azureUser)
      : canWriteSource
    : false;
  const canPublishReview = canPersistReview && !adoRecovery && !adoReadError;
  const localOnlyCommentCount = useMemo(
    () => threads.reduce(
      (count, thread) => count + thread.comments.filter((comment) => comment.localOnly).length,
      0
    ),
    [threads]
  );
  const canSaveReview = canPublishReview && localOnlyCommentCount === 0;
  const canMutateShared = (!sourceTarget || canWriteSource) && !adoRecovery && !adoReadError;
  const currentDocumentDraft = editing ? draftMd : recoveredDocument?.sourceKey === docPath ? recoveredDocument.markdown : markdown;
  const htmlSource = documentFormat === 'html';
  const renderedDocumentHtml = useMemo(
    () => renderSourceDocumentHtml(markdown, documentFormat),
    [markdown, documentFormat]
  );
  const renderedDraftHtml = useMemo(
    () => renderSourceDocumentHtml(draftMd, documentFormat),
    [draftMd, documentFormat]
  );
  const reviewDocumentText = useMemo(
    () => documentTextForReview(markdown, documentFormat),
    [markdown, documentFormat]
  );
  const sourceTitleText = useMemo(
    () => documentTitleFor(markdown, documentFormat),
    [markdown, documentFormat]
  );
  const currentSourceKey = sourceTarget ? sourceStorageKey(sourceTarget) : docPath;
  const reviewAccount = ghUser ? `${ghUser.nodeId ?? ''}:${ghUser.login}` : '';
  if (reviewRequestScope.current.sourceKey !== currentSourceKey || reviewRequestScope.current.account !== reviewAccount) {
    reviewRequestScope.current = { sourceKey: currentSourceKey, account: reviewAccount };
  }
  const currentReviewScope = reviewRequestScope.current;
  const requestReviewChannels = useMemo(
    () => requestReviewEligibility(sourceTarget, { github: Boolean(ghUser), azure: Boolean(azureUser) }),
    [sourceTarget, ghUser, azureUser]
  );
  useEffect(() => {
    setRequestReviewPreview(null);
  }, [currentReviewScope]);
  useEffect(() => {
    setRequestReviewError(reviewStorageWarnings.current.get(currentSourceKey) ?? '');
    setShowHiddenReviews(false);
    setRequestReviewOpen(false);
    try {
      const records = mergeReviewRequestRecords(currentSourceKey,
        loadReviewRequestRecords(localStorage, currentSourceKey),
        reviewRequestMemory.current.get(currentSourceKey) ?? []);
      reviewRequestMemory.current.set(currentSourceKey, records);
      setReviewRequests(records);
    } catch {
      setReviewRequests(reviewRequestMemory.current.get(currentSourceKey) ?? []);
      setRequestReviewError('Saved review requests could not be read for this document.');
    }
    try {
      const remembered = reviewDraftMemory.current.get(currentSourceKey);
      const raw = remembered ? JSON.stringify(remembered) : localStorage.getItem(requestReviewDraftStorageKey(currentSourceKey));
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<ReviewRequestDraft>;
        setRequestReviewDraft({
          ...defaultRequestReviewDraft(sourceTarget, sourceTitleText, now()),
          channel: normalizeRequestReviewDraftChannel(parsed.channel),
          ...(typeof parsed.title === 'string' ? { title: parsed.title } : {}),
          ...(typeof parsed.scope === 'string' ? { scope: parsed.scope } : {}),
          ...(typeof parsed.instructions === 'string' ? { instructions: parsed.instructions } : {}),
          ...(typeof parsed.reviewersText === 'string' ? { reviewersText: parsed.reviewersText } : {}),
          ...(typeof parsed.targetBranch === 'string' ? { targetBranch: parsed.targetBranch } : {}),
          ...(typeof parsed.createdAt === 'string' ? { createdAt: parsed.createdAt } : {}),
        });
      } else {
        setRequestReviewDraft(defaultRequestReviewDraft(sourceTarget, sourceTitleText, now()));
      }
      setRequestReviewPreview(null);
    } catch {
      setRequestReviewDraft(defaultRequestReviewDraft(sourceTarget, sourceTitleText, now()));
      setRequestReviewError('Saved request-review draft could not be read. Starting a fresh draft.');
    }
    setReviewDraftSourceKey(currentSourceKey);
  }, [currentSourceKey]);
  useEffect(() => {
    if (!sourceTarget || sourceTarget.kind !== 'github' || !ghUser) return;
    const fiveMinutesAgo = Date.now() - 5 * 60 * 1000;
    for (const record of reviewRequests) {
      if (record.sourceKey !== currentSourceKey || record.channel !== 'github-issue' || !record.externalNumber) continue;
      if (!['requested', 'in_progress', 'changes_requested', 'stale', 'unknown'].includes(record.status)) continue;
      const refreshKey = `${currentSourceKey}:${reviewAccount}:${record.id}`;
      if (autoRefreshedReviewRequests.current.has(refreshKey)) continue;
      if (record.lastRefreshAt && Date.parse(record.lastRefreshAt) >= fiveMinutesAgo) continue;
      autoRefreshedReviewRequests.current.add(refreshKey);
      void refreshReviewRequest(record, true);
    }
  }, [reviewRequests, sourceTarget, ghUser]);
  const cacheSourceInput = () => {
    const documentText = currentDocumentDraft;
    sourceInputs.current.set(docPath, structuredClone({
      selection: compose,
      comment: composeText,
      mentions: composeMentions,
      intent: composeIntent,
      suggest: composeSuggest,
      replacement: composeReplacement,
      replies: replyDrafts,
      ...(documentText !== savedDraftMd ? { document: documentText } : {}),
    }));
  };
  const restoreSourceInput = (sourceKey: string) => {
    const input = sourceInputs.current.get(sourceKey);
    setCompose(input?.selection ?? null);
    setComposeText(input?.comment ?? '');
    setComposeMentions(input?.mentions ?? []);
    setComposeIntent(input?.intent ?? 'question');
    setComposeSuggest(input?.suggest ?? false);
    setComposeReplacement(input?.replacement ?? '');
    setReplyDrafts(input?.replies ?? {});
  };
  const findDocumentDraft = (sourceKey: string, sourceText: string) => {
    setRecoveredDocument(null);
    setDocumentRecoveryOpen(false);
    setStoredDocumentDraft(null);
    setDocumentDraftProblem(null);
    let persisted: DocThreadFileV1 | null = null;
    try {
      persisted = loadDocumentDraft(localStorage, sourceKey);
    } catch {
      setDocumentDraftProblem({ sourceKey, text: 'The saved browser draft could not be read. It has not been removed.' });
    }
    const draft = sourceInputs.current.get(sourceKey)?.document ?? persisted?.markdown;
    if (typeof draft === 'string' && draft !== sourceText) {
      setRecoveredDocument({ sourceKey, markdown: draft });
    }
    if (persisted?.markdown !== undefined) setStoredDocumentDraft({ sourceKey, markdown: persisted.markdown });
  };
  const forgetDocumentDraft = (sourceKey: string, text: string) => {
    try {
      clearDocumentDraft(localStorage, sourceKey, text);
      setStoredDocumentDraft(previous => previous?.sourceKey === sourceKey && previous.markdown === text ? null : previous);
      return true;
    } catch {
      setDocumentDraftProblem({ sourceKey, text: 'The browser recovery copy could not be removed.' });
      return false;
    }
  };
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (!params.has('doc') && !params.has('target') && !params.has('targetVersion')) findDocumentDraft('sample', SAMPLE_DOC);
  }, []);
  useEffect(() => {
    const text = editing ? draftMd : markdown;
    if (sourceLoading || recoveredDocument) return;
    if (text === savedDraftMd) {
      if (editing && storedDocumentDraft?.sourceKey === docPath) forgetDocumentDraft(docPath, storedDocumentDraft.markdown);
      return;
    }
    try {
      storeDocumentDraft(localStorage, docPath, text);
      setStoredDocumentDraft({ sourceKey: docPath, markdown: text });
      setDocumentDraftProblem(null);
    } catch {
      setDocumentDraftProblem({ sourceKey: docPath, text: 'Could not save the document draft in this browser. Your current text is still in this tab.' });
    }
  }, [docPath, editing, draftMd, markdown, savedDraftMd, sourceLoading, recoveredDocument]);
  const unsentInput = hasUnsentInput({
    comment: compose ? composeText : '',
    replacementChanged: Boolean(compose && composeSuggest && composeReplacement !== compose.anchor.quote),
    documentChanged: currentDocumentDraft !== savedDraftMd,
    replies: Object.values(replyDrafts),
  });
  const mayLeaveSource = (run: () => void) => {
    cacheSourceInput();
    const reason = leaveSourceReason(sourceLoading || saving || pendingOperations.current > 0, unsentInput, feedbackNotice);
    if (reason === 'busy') {
      setStatus('A source operation is still in progress.');
      return false;
    }
    if (reason) {
      setPendingLeave({ run, reason });
      return false;
    }
    return true;
  };
  useEffect(() => {
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      const otherDrafts = [...sourceInputs.current.entries()].some(([key, draft]) => key !== docPath && hasUnsentInput({ comment: draft.comment, replacementChanged: Boolean(draft.selection && draft.suggest && draft.replacement !== draft.selection.anchor.quote), documentChanged: draft.document !== undefined, replies: Object.values(draft.replies) }));
      if (!leaveSourceReason(sourceLoading || saving || operationCount > 0, unsentInput || otherDrafts, feedbackNotice)) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeLeaving);
    return () => window.removeEventListener('beforeunload', warnBeforeLeaving);
  }, [sourceLoading, saving, operationCount, unsentInput, feedbackNotice, docPath]);
  // Device-flow prompt shown while the user completes sign-in in another tab.
  const [deviceCode, setDeviceCode] = useState<DeviceCode | null>(null);
  const deviceAbort = useRef<AbortController | null>(null);
  const [deviceExpiresAt, setDeviceExpiresAt] = useState<number | null>(null);
  const [deviceSecondsLeft, setDeviceSecondsLeft] = useState(0);
  const [deviceCopied, setDeviceCopied] = useState(false);

  useEffect(() => {
    if (!deviceExpiresAt) return;
    const updateCountdown = () => {
      const seconds = Math.max(0, Math.ceil((deviceExpiresAt - Date.now()) / 1000));
      setDeviceSecondsLeft(seconds);
      if (seconds === 0 && deviceAbort.current) {
        deviceAbort.current.abort();
        deviceAbort.current = null;
        setDeviceCode(null);
        setDeviceExpiresAt(null);
        setStatus('The GitHub sign-in code expired. Request a new code to continue.');
      }
    };
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [deviceExpiresAt]);

  const refreshAuth = useCallback(async () => {
    try {
      const s = await getAuthStatus();
      setGhUser(
        s.authenticated
          ? { login: s.login!, name: s.name, nodeId: s.nodeId, avatarUrl: s.avatarUrl }
          : null
      );
    } catch {
      setGhUser(null);
    } finally {
      setAuthChecked(true);
    }
  }, []);

  const refreshAzureAuth = useCallback(async () => {
    try {
      const status = await getAzureAuthStatus();
      setAzureUser(
        status.authenticated && status.login
          ? {
              login: status.login,
              name: status.name,
              objectId: status.objectId,
              tenantId: status.tenantId,
            }
          : null
      );
    } catch {
      setAzureUser(null);
    } finally {
      setAzureAuthChecked(true);
    }
  }, []);

  useEffect(() => {
    refreshAuth();
    refreshAzureAuth();
  }, [refreshAuth, refreshAzureAuth]);

  const signIn = async () => {
    if (AUTH_MODE === 'static') {
      setStatus('GitHub sign-in is not configured for this deployment.');
      return;
    }
    if (AUTH_MODE === 'dev') {
      setStatus('Checking GitHub CLI sign-in…');
      try {
        const result = await startDevLogin();
        if (result.authenticated) {
          await refreshAuth();
          setDevLoginStarted(false);
          setStatus(`Signed in to GitHub as ${result.login}.`);
          return;
        }
        setDevLoginStarted(result.started);
        setStatus('Complete GitHub sign-in in the opened console, then select Recheck sign-in.');
      } catch (error: any) {
        setStatus(`Could not start GitHub sign-in: ${error?.message ?? error}`);
      }
      return;
    }
    // Hosted: GitHub device flow.
    deviceAbort.current?.abort();
    const controller = new AbortController();
    deviceAbort.current = controller;
    try {
      setStatus('Requesting a GitHub sign-in code…');
      const dc = await startDeviceLogin(controller.signal);
      if (deviceAbort.current !== controller || controller.signal.aborted) return;
      setDeviceCode(dc);
      setDeviceExpiresAt(Date.now() + dc.expiresIn * 1000);
      setDeviceCopied(false);
      setStatus('Your GitHub sign-in code is ready.');
      await pollForDeviceToken(dc, controller.signal);
      if (deviceAbort.current !== controller) return;
      deviceAbort.current = null;
      setDeviceCode(null);
      setDeviceExpiresAt(null);
      await refreshAuth();
      setStatus('Signed in to GitHub ✔');
    } catch (e: any) {
      if (deviceAbort.current !== controller) return;
      deviceAbort.current = null;
      setDeviceCode(null);
      setDeviceExpiresAt(null);
      setStatus(`Sign-in failed: ${e.message ?? e}`);
    }
  };

  const cancelDeviceLogin = () => {
    deviceAbort.current?.abort();
    deviceAbort.current = null;
    setDeviceCode(null);
    setDeviceExpiresAt(null);
    setStatus('Sign-in cancelled.');
  };

  const requestNewDeviceCode = () => {
    deviceAbort.current?.abort();
    deviceAbort.current = null;
    setDeviceCode(null);
    setDeviceExpiresAt(null);
    void signIn();
  };

  const copyDeviceCode = async () => {
    if (!deviceCode) return;
    try {
      await navigator.clipboard.writeText(deviceCode.userCode);
      setDeviceCopied(true);
    } catch {
      setDeviceCopied(false);
      setStatus('Copy was blocked. Select the visible code and copy it manually.');
    }
  };

  const openDevicePage = () => {
    if (!deviceCode) return;
    const opened = window.open(deviceCode.verificationUri, '_blank', 'noopener');
    if (!opened) setStatus('The GitHub tab was blocked. Allow popups or open the link manually.');
  };

  const signOut = async () => {
    await signOut_();
    setGhUser(null);
    setDevLoginStarted(false);
    setStatus(
      AUTH_MODE === 'dev'
        ? 'Signing out… confirm in the console window, then click “I’ve signed in” to refresh.'
        : 'Signed out.'
    );
  };

  const signInToAzure = async (): Promise<boolean> => {
    setStatus('Checking Microsoft Entra sign-in…');
    try {
      const result =
        AZURE_AUTH_MODE === 'static' && GRAPH_TRANSPORT === 'msal'
          ? await startGraphLogin()
          : await startAzureLogin();
      if (result.authenticated) {
        await refreshAzureAuth();
        setAzureLoginStarted(false);
        setStatus(`Signed in for Azure Repos as ${result.login}.`);
        return true;
      }
      setAzureLoginStarted(result.started);
      setStatus('Complete Azure sign-in in the opened window, then select Recheck sign-in.');
      return false;
    } catch (error: any) {
      setStatus(`Azure sign-in failed: ${error?.message ?? error}`);
      return false;
    }
  };

  const signInToDirectory = async () => {
    setStatus('Requesting permission to search your organization directory…');
    try {
      const result = await startGraphLogin();
      if (result.authenticated) await refreshAzureAuth();
      setStatus(`Directory search enabled as ${result.login || 'your Microsoft account'}.`);
    } catch (error: any) {
      setStatus(`Microsoft directory sign-in failed: ${error?.message ?? error}`);
    }
  };

  const signOutOfAzure = async () => {
    try {
      await signOutAzure();
      setAzureUser(null);
      setAzureLoginStarted(false);
      setStatus('Signed out of Microsoft Entra.');
    } catch (error: any) {
      setStatus(`Azure sign-out failed: ${error?.message ?? error}`);
    }
  };

  const searchIdentities = useCallback(
    async (term: string, signal: AbortSignal): Promise<IdentitySearchOutcome> => {
      const target = sourceTargetRef.current;
      if (!target) return { kind: 'unavailable' };
      if (target.kind === 'github') {
        if (!ghUser) return { kind: 'needs-signin', authority: 'github' };
        const graphToken =
          GRAPH_TRANSPORT === 'msal' ? await getGraphAccessToken(false) : '';
        const graphReady = Boolean(graphToken && azureUser?.tenantId);

        if (term.includes('@')) {
          // Email-intent search — Microsoft directory.
          if (GRAPH_TRANSPORT !== 'msal') return { kind: 'unavailable' };
          if (!graphReady) return { kind: 'needs-signin', authority: 'microsoft' };
          const graphCandidates = await searchGraphUsers(
            fetch,
            graphToken,
            azureUser?.tenantId || MICROSOFT_TENANT_ID,
            term,
            signal
          );
          const joined = await joinGraphMailToGitHubCollaborators(
            fetch,
            GH_API_BASE,
            getToken(),
            { owner: target.owner, repo: target.repo },
            graphCandidates,
            signal
          );
          // Also surface directory people whose GitHub public email did not
          // corroborate (e.g. EMU accounts), so they can still be emailed via the
          // relay. `joined` links the Entra key into its candidate, so exclude
          // those to avoid showing the same person twice.
          const joinedEntraKeys = new Set(
            joined.flatMap((candidate) =>
              candidate.subject.linkedKeys.filter((key) => key.startsWith('entra:'))
            )
          );
          const directoryOnly = graphCandidates.filter(
            (candidate) => !joinedEntraKeys.has(candidate.subject.subjectKey)
          );
          return {
            kind: 'results',
            candidates: rankIdentityCandidates([...joined, ...directoryOnly], term),
          };
        }

        // Plain handle search — GitHub collaborators. When the viewer is already
        // signed into Microsoft, additionally surface directory (Entra) people so
        // their mentions can be delivered by email through the relay. When not
        // signed into Microsoft this is unchanged (GitHub collaborators only).
        const githubCandidates = await searchGitHubCollaborators(
          fetch,
          GH_API_BASE,
          getToken(),
          { owner: target.owner, repo: target.repo },
          term,
          signal
        );
        if (graphReady) {
          const entraCandidates = await searchGraphUsers(
            fetch,
            graphToken,
            azureUser?.tenantId || MICROSOFT_TENANT_ID,
            term,
            signal
          );
          return {
            kind: 'results',
            candidates: rankIdentityCandidates(
              [...githubCandidates, ...entraCandidates],
              term
            ),
          };
        }
        return { kind: 'results', candidates: rankIdentityCandidates(githubCandidates, term) };
      }
      if (GRAPH_TRANSPORT !== 'msal') return { kind: 'unavailable' };
      const token = await getGraphAccessToken(false);
      if (!token || !azureUser?.tenantId) {
        return { kind: 'needs-signin', authority: 'microsoft' };
      }
      const candidates = await searchGraphUsers(
        fetch,
        token,
        azureUser.tenantId || MICROSOFT_TENANT_ID,
        term,
        signal
      );
      return { kind: 'results', candidates: rankIdentityCandidates(candidates, term) };
    },
    [azureUser?.tenantId, ghUser]
  );

  const requestIdentitySignIn = async (authority: 'github' | 'microsoft') => {
    if (authority === 'github') await signIn();
    else await signInToDirectory();
  };

  const docRef = useRef<HTMLDivElement | null>(null);
  const htmlFrameShellRef = useRef<HTMLDivElement | null>(null);
  const htmlFrameRef = useRef<HTMLIFrameElement | null>(null);
  // Inner element that actually holds the rendered Markdown. React only ever
  // sets its innerHTML (as an opaque string), so our manual highlight spans
  // never collide with React's child reconciliation (which caused the
  // "removeChild … is not a child of this node" crash).
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // Render the current source text to a static HTML string once per doc change.
  // React treats this as opaque via dangerouslySetInnerHTML.
  const docHtml = renderedDocumentHtml;
  const htmlFrameSrcDoc = useMemo(
    () => (htmlSource ? buildHtmlSrcDoc(markdown, sourceTarget ? sourceFileUrl(sourceTarget) : undefined) : ''),
    [htmlSource, markdown, sourceTarget]
  );
  const htmlDraftFrameSrcDoc = useMemo(
    () => (htmlSource ? buildHtmlSrcDoc(draftMd, sourceTarget ? sourceFileUrl(sourceTarget) : undefined) : ''),
    [htmlSource, draftMd, sourceTarget]
  );
  const syncHtmlFrameHeight = useCallback(() => {
    const frame = htmlFrameRef.current;
    const doc = frame?.contentDocument;
    if (!frame || !doc?.documentElement) return;
    const height = Math.max(
      doc.documentElement.scrollHeight,
      doc.body?.scrollHeight ?? 0,
      doc.documentElement.offsetHeight,
      doc.body?.offsetHeight ?? 0,
      640
    );
    setHtmlFrameHeight(height);
  }, []);
  const syncHtmlFrameScale = useCallback(() => {
    setHtmlFrameScale(1);
  }, []);

  // Refs + a revision counter so we can auto-commit comments to GitHub (making them
  // visible to everyone with repo access) without stale-closure bugs.
  const threadsRef = useRef(threads);
  const sourceTargetRef = useRef(sourceTarget);
  const sidecarRevisionRef = useRef(sidecarRevision);
  const markdownRef = useRef(markdown);
  const sourceLoadGeneration = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // When a repository document is loaded, connectSource already sets the correct
  // threads. This flag stops the docPath effect below from
  // immediately clobbering them with the local-only copy.
  const suppressLocalLoad = useRef(false);
  const [sourceRev, setSourceRev] = useState(0);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);
  useEffect(() => {
    sourceTargetRef.current = sourceTarget;
  }, [sourceTarget]);
  useEffect(() => {
    sidecarRevisionRef.current = sidecarRevision;
  }, [sidecarRevision]);
  useEffect(() => {
    markdownRef.current = markdown;
  }, [markdown]);
  useEffect(() => setAttributionDismissed(false), [docPath]);

  // ---- Load threads whenever the doc changes ----
  useEffect(() => {
    if (suppressLocalLoad.current) {
      suppressLocalLoad.current = false;
      return;
    }
    const file = loadLocal(docPath);
    // The built-in sample ships with an example review so first-time visitors
    // see how threads look; fall back to it when there's no saved local copy.
    setThreads(docPath === 'sample' ? loadSampleThreads() : (file?.threads ?? []));
    setActiveId(null);
  }, [docPath]);

  // ---- Persist threads (localStorage) ----
  const persistLocal = useCallback(
    (next: Thread[]) => {
      saveLocal(reviewFile(docPath, next, sourceTarget, markdown), docPath);
      if (docPath === 'sample') {
        try {
          localStorage.setItem(SAMPLE_VERSION_KEY, SAMPLE_VERSION);
        } catch {
          /* ignore storage errors */
        }
      }
    },
    [docPath, markdown, sourceTarget]
  );

  const updateThreads = useCallback(
    (updater: (prev: Thread[]) => Thread[]) => {
      const next = updater(threadsRef.current);
      try {
        persistLocal(next);
        setLocalSaveError('');
      } catch {
        setLocalSaveError('Could not store feedback in this browser. Your input has been kept; copy it before leaving.');
        return false;
      }
      threadsRef.current = next;
      setThreads(next);
      setFeedbackNotice({
        sourceKey: docPath,
        version: ++feedbackVersion.current,
        phase: canPublishReview && !next.some(thread => thread.comments.some(comment => comment.localOnly)) ? 'pending' : 'local',
      });
      setSourceRev((revision) => revision + 1);
      return true;
    },
    [persistLocal, docPath, canPublishReview]
  );

  const adoptSavedSidecar = useCallback(
    (saved: LoadedSourceSidecar, target: SourceTarget) => {
      const targetKey = sourceStorageKey(target);
      const currentTarget = sourceTargetRef.current;
      if (!currentTarget || sourceStorageKey(currentTarget) !== targetKey) {
        if (saved.file) {
          const local = loadLocal(targetKey);
          const accepted = local?.schemaVersion === 2 ? mergeDocThreadFiles(local, saved.file, { target: 'local' }) : saved.file;
          saveLocal(accepted, targetKey);
        }
        return;
      }
      sidecarRevisionRef.current = saved.revision;
      setSidecarRevision(saved.revision);
      if (!saved.file) return;
      const current = reviewFile(
        docPath,
        threadsRef.current,
        target,
        markdownRef.current
      );
      const accepted =
        current.schemaVersion === 2
          ? mergeDocThreadFiles(current, saved.file, { target: 'local' })
          : saved.file;
      threadsRef.current = accepted.threads;
      setThreads(accepted.threads);
      saveLocal(accepted, docPath);
    },
    [docPath]
  );

  // ---- Auto-commit comments so anyone with repository access sees them ----
  useEffect(() => {
    if (!sourceTargetRef.current || !canSaveReview || sourceRev === 0) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const target = sourceTargetRef.current!;
      const targetKey = sourceStorageKey(target);
      const receipt = { sourceKey: targetKey, version: feedbackVersion.current };
      const finish = beginOperation();
      setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'saving' }));
      try {
        const file = reviewFile(docPath, threadsRef.current, target, markdownRef.current);
        if (target.kind === 'ado-workitem') {
          if (file.schemaVersion !== 1) throw new Error('ADO review payload must be schema-v1.');
          await saveAdoReview(target, file);
          if (
            sourceTargetRef.current &&
            sourceStorageKey(sourceTargetRef.current) === targetKey
          ) {
            setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'saved' }));
          }
          return;
        }
        const saved = await saveSourceSidecar(target, file, sidecarRevisionRef.current);
        adoptSavedSidecar(saved, target);
        if (
          sourceTargetRef.current &&
          sourceStorageKey(sourceTargetRef.current) === targetKey
        ) {
          setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'saved' }));
        }
      } catch (e: any) {
        if (
          sourceTargetRef.current &&
          sourceStorageKey(sourceTargetRef.current) === targetKey
        ) {
          setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'failed', error: String(e.message ?? e) }));
        }
      } finally {
        finish();
      }
    }, 900);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceRev, docPath, canSaveReview]);

  const attributeAndPublish = () => {
    if (!commentAuthor || commentAuthorIdentityKeys.length === 0) return;
    const attributed = attributeLocalComments(threadsRef.current, {
      author: commentAuthor,
      authorLogin: commentAuthorLogin,
      authorIdentityKeys: commentAuthorIdentityKeys,
    });
    if (!updateThreads(() => attributed.threads)) return;
    setAttributionDismissed(true);
    setStatus(
      `Attributed ${attributed.count} local comment${attributed.count === 1 ? '' : 's'} to ${commentAuthor}; publishing to the source review.`
    );
  };

  const persistAndNotify = useCallback(
    async (
      submitted: Comment,
      mentionsForEmail: readonly MentionReference[] | undefined,
      threadId: string
    ) => {
      const notificationSource = sourceTargetRef.current;
      const notificationKey = notificationSource ? sourceStorageKey(notificationSource) : 'sample';
      const operation = captureReviewOperation(
        notificationSource,
        notificationKey,
        reviewFile(docPath, threadsRef.current, notificationSource, markdownRef.current),
        sidecarRevisionRef.current,
        feedbackVersion.current
      );
      const finish = beginOperation();
      const reportNotification = (text: string) => {
        const current = sourceTargetRef.current;
        if ((current ? sourceStorageKey(current) : 'sample') === notificationKey) {
          setNotificationNotice({ sourceKey: notificationKey, text });
        }
      };
      try {
      // Email any resolved @mentions we have an address for. This is provider-
      // agnostic (works for ADO work items and GitHub) and routes through the
      // Outlook Logic App via /api/notify. GitHub-only users generally have no
      // email here, so they are still notified natively by GitHub without a
      // duplicate email. We read the ORIGINAL resolved mentions (before any
      // local-only downgrade), because emailing does not require repository write
      // access — a read-only source must not suppress the notification.
      const emailMentions = mentionsForEmail ?? submitted.mentions;
      const emailContacts = collectMentionEmailTargets(emailMentions, mentionContact);
      const emailByAddress = new Map(
        emailContacts.map((contact) => [contact.email.toLocaleLowerCase(), contact])
      );
      // Handles we actually emailed — so a mention that was downgraded to
      // "unresolved" for persistence but still emailed is not falsely reported as
      // "not notified".
      const emailedHandles = new Set(
        (emailMentions || []).flatMap((mention) =>
          mention.kind === 'resolved' && mentionContact(mention.subjectKey)
            ? [mention.handle.toLocaleLowerCase()]
            : []
        )
      );

      // Self-mention: the viewer @mentioning their own handle. On ADO this stays
      // "unresolved" (the local suggestion has no directory identity); on GitHub it
      // resolves to the GitHub route, whose native notification GitHub does NOT
      // email back to the author. Either way we know the viewer's own Microsoft
      // email (the Azure/ADO sign-in login), so notify them through the relay —
      // testing your own review, and legitimately notifying yourself, should work.
      const viewerEmail =
        azureUser?.login && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(azureUser.login)
          ? azureUser.login
          : undefined;
      const viewerHandle = commentAuthorLogin?.toLocaleLowerCase();
      if (
        viewerEmail &&
        viewerHandle &&
        (submitted.mentions || []).some(
          (mention) => mention.handle.toLocaleLowerCase() === viewerHandle
        )
      ) {
        emailByAddress.set(viewerEmail.toLocaleLowerCase(), {
          email: viewerEmail,
          displayName: commentAuthor || 'You',
        });
        emailedHandles.add(viewerHandle);
      }

      const emailTargets = [...emailByAddress.values()];
      const unresolved = (submitted.mentions || [])
        .filter(
          (mention) =>
            mention.kind === 'unresolved' &&
            !emailedHandles.has(mention.handle.toLocaleLowerCase())
        )
        .map((mention) => `@${(mention as { handle: string }).handle}`);
      let unverifiedSuffix = unresolved.length
        ? ` Unverified ${unresolved.join(', ')} was not notified.`
        : '';

      if (emailTargets.length > 0) {
        const emailTarget = operation.source;
        // The email must open the document *in DocThread* (which loads the review
        // sidecar and shows the comments), not the raw source file. sourceDeepLink
        // encodes the canonical GitHub target, or ?source/?doc for other providers.
        const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString();
        // Deep-link straight to the mentioned comment's thread (#32): opens the
        // document *and* focuses/scrolls to the exact comment, instead of just
        // loading the doc and leaving the reader to find it.
        const docUrl = emailTarget ? sourceDeepLink(appUrl, emailTarget, threadId) : undefined;
        const { subject, html } = buildMentionEmail({
          actor: commentAuthor || 'A DocThread reviewer',
          docLabel: emailTarget ? sourceDocumentLabel(emailTarget) : docPath,
          docUrl,
          commentBody: submitted.body,
        });
        const who = [...new Set(emailTargets.map((contact) => contact.displayName))].join(', ');
        const result = await sendMentionEmail(NOTIFY_ENDPOINT, {
          to: emailTargets.map((contact) => contact.email),
          subject,
          html,
        });
        unverifiedSuffix += result.delivered
          ? ` Email request accepted for ${who}; delivery unconfirmed.`
          : ` Email request for ${who} failed (${result.reason || 'unknown'}).`;

        // Optional Teams delivery (opt-in via VITE_TEAMS_NOTIFY). Reuses the same
        // relay + recipient allowlist; the relay no-ops unless TEAMS_WEBHOOK_URL is
        // configured server-side. Never blocks or breaks the comment flow.
        if (TEAMS_NOTIFY_ENABLED) {
          const card = buildTeamsMessage({
            actor: commentAuthor || 'A DocThread reviewer',
            docLabel: emailTarget ? sourceDocumentLabel(emailTarget) : docPath,
            docUrl,
            commentBody: submitted.body,
            recipients: [...new Set(emailTargets.map((contact) => contact.displayName))],
          });
          const teamsResult = await sendTeamsNotification(NOTIFY_ENDPOINT, {
            to: emailTargets.map((contact) => contact.email),
            card,
          });
          if (teamsResult.delivered) unverifiedSuffix += ' Teams request accepted.';
        }
      }

      if (!submitted.dispatch) {
        const resolved = (submitted.mentions || []).some(
          (mention) => mention.kind === 'resolved'
        );
        if (unresolved.length || emailTargets.length) {
          reportNotification(unverifiedSuffix.trim());
        } else if (resolved) {
          reportNotification('Provider notification is not available.');
        }
        return;
      }
      const target = operation.source;
      if (!target || target.kind !== 'github') {
        reportNotification(`Provider notification is not available.${unverifiedSuffix}`);
        return;
      }
      if (sourceTargetRef.current && isCurrentReviewOperation(operation, sourceStorageKey(sourceTargetRef.current), feedbackVersion.current) && saveTimer.current) clearTimeout(saveTimer.current);

      const receipt = { sourceKey: operation.sourceKey, version: operation.version };
      let feedbackAccepted = false;
      setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'saving' }));
      try {
        const pendingFile = operation.file;
        if (pendingFile.schemaVersion !== 2) {
          throw new Error('Notification dispatch requires schema-v2 review storage.');
        }
        const pendingSaved = await saveSourceSidecar(
          target,
          pendingFile,
          operation.revision
        );
        adoptSavedSidecar(pendingSaved, target);
        if (!pendingSaved.file) throw new Error('The persisted review was not returned.');
        const accepted = findComment(pendingSaved.file, submitted.id);
        assertImmutableCommentAccepted(submitted, accepted);
        feedbackAccepted = true;
        setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'saved' }));
        if (accepted.dispatch?.state !== 'pending') {
          throw new Error('Notification was already claimed; it will not be sent again.');
        }

        const recipientSet = new Set(accepted.dispatch.recipientKeys);
        const routes = (accepted.mentions || []).flatMap((mention) =>
          mention.kind === 'resolved' &&
          mention.route.kind === 'github' &&
          recipientSet.has(mention.subjectKey)
            ? [{ nodeId: mention.route.nodeId }]
            : []
        );
        const dispatchToken = getToken();
        if (AUTH_MODE === 'oauth' && !dispatchToken) {
          throw new Error('GitHub sign-in changed before notification dispatch.');
        }
        const authorNodeId = accepted.authorIdentityKeys
          ?.find((key) => key.startsWith('github:'))
          ?.slice('github:'.length);
        if (!authorNodeId) {
          throw new Error('The persisted comment has no GitHub author identity.');
        }
        const handles = await verifyGitHubNotificationRecipients(
          fetch,
          GH_API_BASE,
          dispatchToken,
          { owner: target.owner, repo: target.repo },
          routes,
          authorNodeId
        );

        const attemptedAt = now();
        const attempted: NotificationDispatch = {
          ...accepted.dispatch,
          state: 'attempted',
          attemptId: crypto.randomUUID(),
          attemptedAt,
        };
        const claimedFile = transitionCommentDispatch(
          pendingSaved.file,
          submitted.id,
          attempted,
          attemptedAt
        );
        const claimedSaved = await saveSourceSidecar(
          target,
          claimedFile,
          pendingSaved.revision
        );
        adoptSavedSidecar(claimedSaved, target);
        if (!claimedSaved.file) throw new Error('The notification claim was not returned.');
        const claimed = findComment(claimedSaved.file, submitted.id);
        if (
          claimed.dispatch?.state !== 'attempted' ||
          claimed.dispatch.attemptId !== attempted.attemptId
        ) {
          throw new Error('The notification claim was not durably accepted.');
        }

        const who = handles.map((handle) => `@${handle}`).join(' ');
        reportNotification(`Notifying ${who} on GitHub...`);
        let terminal: NotificationDispatch;
        try {
          const result = await notifyMentions(dispatchToken, target, {
            mentions: handles,
            expectedViewerNodeId: authorNodeId,
          });
          terminal = { ...attempted, state: 'delivered', providerUrl: result.url };
        } catch (error: any) {
          const definitelyNotSent = Number(error?.status) >= 400 && Number(error?.status) < 500;
          terminal = {
            ...attempted,
            state: definitelyNotSent ? 'failed' : 'uncertain',
            errorCode: error?.status ? `github-${error.status}` : 'request-outcome-unknown',
          };
        }

        const terminalFile = transitionCommentDispatch(
          claimedSaved.file,
          submitted.id,
          terminal,
          now()
        );
        try {
          const terminalSaved = await saveSourceSidecar(
            target,
            terminalFile,
            claimedSaved.revision
          );
          adoptSavedSidecar(terminalSaved, target);
        } catch (error: any) {
          reportNotification(
            `Notification was attempted, but its final status could not be saved: ${error?.message ?? error}`
          );
          return;
        }

        if (terminal.state === 'delivered') {
          reportNotification(`GitHub accepted the notification for ${who}.${unverifiedSuffix}`);
        }
        else if (terminal.state === 'failed') {
          reportNotification(
            `GitHub did not accept the notification for ${who}; it will not be retried.${unverifiedSuffix}`
          );
        } else {
          reportNotification(
            `GitHub notification outcome for ${who} is uncertain; it will not be retried.${unverifiedSuffix}`
          );
        }
      } catch (error: any) {
        if (!feedbackAccepted) setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'failed', error: String(error?.message ?? error) }));
        reportNotification(`Notification not confirmed: ${error?.message ?? error}${unverifiedSuffix}`);
      }
      } finally {
        finish();
      }
    },
    [adoptSavedSidecar, docPath, commentAuthor, commentAuthorLogin, usingAzure, azureUser?.login]
  );

  // ---- Re-anchor + paint highlights after every render of the doc ----
  useLayoutEffect(() => {
    if (editing) return;
    const root = bodyRef.current;
    if (!root) return;
    try {
      paintHighlights(root);
    } catch (err) {
      // A bad anchor must never blank the whole document — degrade gracefully.
      console.error('DocThread: highlight pass failed', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docHtml, activeId, editing, htmlFrameLoadCount, paintSignature(visibleThreads)]);

  useLayoutEffect(() => {
    const root = bodyRef.current;
    const ownerWindow = root?.ownerDocument.defaultView ?? window;
    const highlights = (ownerWindow.CSS as any)?.highlights;
    const HighlightRange = (ownerWindow as any).Highlight;
    if (!highlights || !HighlightRange) return;
    highlights.delete('compose-anchor');
    if (!compose || editing || sourceLoading || !root) return;
    try {
      const located = locateAnchor(root, compose.anchor);
      if (located) highlights.set('compose-anchor', new HighlightRange(located.range));
    } catch (error) {
      console.error('DocThread: draft highlight failed', error);
    }
    return () => { highlights.delete('compose-anchor'); };
  }, [compose, docHtml, activeId, editing, sourceLoading, paintSignature(visibleThreads)]);

  // Remove any highlight spans we previously injected, merging their text back
  // into the parent. Because React owns this subtree only as an opaque HTML
  // string, we must clear our own spans before repainting (idempotent).
  const clearHighlights = (root: HTMLDivElement) => {
    const spans = Array.from(root.querySelectorAll('span[data-thread-id]'));
    for (const span of spans) {
      const parent = span.parentNode;
      if (!parent) continue;
      while (span.firstChild) parent.insertBefore(span.firstChild, span);
      parent.removeChild(span);
      (parent as Element).normalize?.();
    }
  };

  // Locate every thread's anchor in the freshly rendered doc and wrap the
  // matching text in highlight spans. Extracted so the caller can try/catch it.
  const paintHighlights = (root: HTMLDivElement) => {
    // Clear previous highlights first so repaints (e.g. on selection change) are idempotent.
    clearHighlights(root);
    const map = buildTextMap(root);

    type Seg = {
      node: Text;
      start: number;
      end: number;
      classes: string[];
      id: string;
    };
    const segs: Seg[] = [];
    let orphans = 0;

    const located = visibleThreads.map((t) => {
      let res: ReturnType<typeof locateAnchor> = null;
      try {
        res = locateAnchor(root, t.anchor);
      } catch {
        res = null;
      }
      if (!res) {
        orphans++;
        return { ...t, located: false, confidence: 'orphaned' as AnchorConfidence };
      }
      const cls = ['dt-highlight'];
      if (t.resolved) cls.push('resolved');
      if (res.confidence === 'needs-confirmation') cls.push('unsure');
      else if (res.confidence === 'medium') cls.push('fuzzy');
      if (t.id === activeId) cls.push('active');
      // Compute per-node segments from the global offsets.
      for (const entry of map.nodes) {
        const nodeStart = entry.start;
        const nodeEnd = entry.start + entry.node.data.length;
        const s = Math.max(res.startOffset, nodeStart);
        const e = Math.min(res.endOffset, nodeEnd);
        if (e > s) {
          segs.push({
            node: entry.node,
            start: s - nodeStart,
            end: e - nodeStart,
            classes: cls,
            id: t.id,
          });
        }
      }
      return { ...t, located: true, confidence: res.confidence };
    });

    // Paint: group by node, wrap from the end backwards so offsets stay valid.
    const byNode = new Map<Text, Seg[]>();
    for (const seg of segs) {
      if (!seg.node.isConnected) continue;
      const arr = byNode.get(seg.node) ?? [];
      arr.push(seg);
      byNode.set(seg.node, arr);
    }
    for (const [node, arr] of byNode) {
      const nodeOffset = map.nodes.find(entry => entry.node === node)?.start ?? 0;
      for (const flat of flattenRanges(arr, node.data.length).sort(
        (a, b) => b.start - a.start
      )) {
        try {
          let target = node;
          if (flat.start > 0) target = target.splitText(flat.start);
          if (flat.end - flat.start < target.data.length) {
            target.splitText(flat.end - flat.start);
          }
          const span = document.createElement('span');
          span.className = flat.classes.join(' ');
          // The primary id preserves existing click and scroll behavior.
          span.setAttribute('data-thread-id', flat.ids[0]);
          span.setAttribute('data-anchor-offset', String(nodeOffset + flat.start));
          if (flat.ids.length > 1) {
            span.setAttribute('data-thread-ids', flat.ids.join(' '));
            span.title = `${flat.ids.length} discussions on this text`;
          }
          span.setAttribute('role', 'button');
          span.setAttribute('tabindex', '0');
          span.setAttribute(
            'aria-label',
            `Comment thread${flat.ids.length > 1 ? `s (${flat.ids.length})` : ''}`
          );
          target.parentNode?.insertBefore(span, target);
          span.appendChild(target);
        } catch {
          /* ignore paint failures for this segment */
        }
      }
    }

    setOrphanCount(orphans);
    // Sync located flags into state without re-persisting (avoid loops).
    setThreads((prev) => {
      let changed = false;
      const merged = prev.map((t) => {
        const l = located.find((x) => x.id === t.id);
        if (l && (l.located !== t.located || l.confidence !== t.confidence)) {
          changed = true;
          return { ...t, located: l.located, confidence: l.confidence };
        }
        return t;
      });
      return changed ? merged : prev;
    });
  };

  // ---- Selection → compose popup ----
  const handleMouseUp = useCallback((rootWindow: Window = window) => {
    if (editing || sourceLoading || !identityChecked || !canComment) return;
    const sel = rootWindow.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const root = bodyRef.current;
    const host = htmlSource ? htmlFrameShellRef.current : docRef.current;
    if (!root || !host || !root.contains(range.commonAncestorContainer)) return;
    const anchor = createAnchor(root, range);
    if (!anchor || !anchor.quote.trim()) return;
    if (compose && (composeText.trim() || (composeSuggest && composeReplacement !== compose.anchor.quote))) {
      setStatus('Your unsent comment is still attached to the original selection.');
      return;
    }
    const rect = range.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    setCompose({
      x: rect.left - hostRect.left + host.scrollLeft,
      y: rect.bottom - hostRect.top + host.scrollTop + 6,
      anchor,
    });
    setComposeText('');
    setComposeMentions([]);
    setComposeIntent('question');
    setComposeSuggest(false);
    setComposeReplacement(anchor.quote);
  }, [canComment, editing, identityChecked, sourceLoading, compose, composeText, composeSuggest, composeReplacement, htmlSource, htmlFrameScale]);
  const onMouseUp = useCallback((event?: React.MouseEvent) => {
    selectionClick.current = Boolean(event);
    setActiveId(null);
    handleMouseUp(window);
  }, [handleMouseUp]);

  const moveDocumentSelection = (event: ReactKeyboardEvent<HTMLDivElement>, rootWindow: Window = window) => {
    if (event.target !== event.currentTarget || event.altKey || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const root = bodyRef.current;
    const selection = rootWindow.getSelection();
    if (!root || !selection || typeof selection.modify !== 'function') return;
    if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
      const first = buildTextMap(root).nodes[0]?.node;
      if (!first) return;
      selection.collapse(first, 0);
    }
    const previous = selection.getRangeAt(0).cloneRange();
    const direction = ['ArrowLeft', 'ArrowUp', 'Home'].includes(event.key) ? 'backward' : 'forward';
    const boundary = event.key === 'Home' || event.key === 'End';
    const granularity = boundary
      ? event.ctrlKey || event.metaKey ? 'documentboundary' : 'lineboundary'
      : event.key === 'ArrowUp' || event.key === 'ArrowDown' ? 'line'
      : event.ctrlKey || event.metaKey ? 'word' : 'character';
    event.preventDefault();
    selection.modify(event.shiftKey ? 'extend' : 'move', direction, granularity);
    if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  };

  const submitCompose = () => {
    if (!compose || !commentAuthor || sourceLoading || !canComment) return;
    // A plain comment needs text; a suggested edit may stand on its own (the
    // body then defaults to a short label) but must actually change the text.
    const isSuggestion = composeSuggest && composeReplacement !== compose.anchor.quote;
    if (!composeText.trim() && !isSuggestion) return;
    const body = composeText.trim() || (isSuggestion ? 'Suggested change' : composeText);
    // ADO reviews persist a whole-file snapshot with the author's display name,
    // so they don't require durable provider identity keys the way the GitHub v2
    // pipeline does.
    const localOnly =
      !sourceTarget ||
      !canPublishReview ||
      (sourceTarget.kind !== 'ado-workitem' && commentAuthorIdentityKeys.length === 0);
    const mentions = finalizeMentionReferences(
      body,
      composeMentions.map((mention) =>
        localOnly && mention.kind === 'resolved'
          ? {
              kind: 'unresolved' as const,
              start: mention.start,
              length: mention.length,
              text: mention.text,
              handle: mention.handle,
            }
          : mention
      )
    );
    const createdAt = now();
    const dispatch = localOnly ? undefined : pendingGitHubDispatch(mentions);
    const comment: Comment = {
      id: uid(),
      author: commentAuthor,
      authorLogin: commentAuthorLogin,
      authorIdentityKeys: commentAuthorIdentityKeys,
      identityVersion: 1,
      ...(localOnly ? { localOnly: true as const } : {}),
      mentions,
      body,
      createdAt,
      ...(dispatch ? { dispatch } : {}),
    };
    const thread: Thread = {
      id: uid(),
      anchor: compose.anchor,
      resolved: false,
      createdAt,
      intent: composeIntent,
      ...(isSuggestion ? { suggestion: { replacement: composeReplacement, origin: 'human' as const } } : {}),
      clocks: { resolutionAt: createdAt, intentAt: createdAt, anchorAt: createdAt },
      comments: [comment],
    };
    if (!updateThreads((prev) => [...prev, thread])) return;
    setCommentHintDismissed(true);
    focusDiscussion(thread.id);
    void persistAndNotify(comment, composeMentions, thread.id);
    setCompose(null);
    setComposeText('');
    setComposeMentions([]);
    setComposeSuggest(false);
    setComposeReplacement('');
    window.getSelection()?.removeAllRanges();
  };

  // Promote an AI-readiness gap (#44) into a draft review thread anchored at the
  // offending span. Reuses the same create + persist + notify path as a manual
  // comment; severity maps to review intent.
  const promoteReadinessGap = (gap: ReadinessGap) => {
    if (!gap.anchor || !commentAuthor || sourceLoading || !canComment) return false;
    const intent: ThreadIntent =
      gap.severity === 'critical' ? 'blocking' : gap.severity === 'important' ? 'suggestion' : 'question';
    const localOnly =
      !sourceTarget ||
      !canPublishReview ||
      (sourceTarget.kind !== 'ado-workitem' && commentAuthorIdentityKeys.length === 0);
    const createdAt = now();
    const body = `**AI-readiness gap: ${gap.title}**\n\n${gap.detail}`;
    const comment: Comment = {
      id: uid(),
      author: commentAuthor,
      authorLogin: commentAuthorLogin,
      authorIdentityKeys: commentAuthorIdentityKeys,
      identityVersion: 1,
      ...(localOnly ? { localOnly: true as const } : {}),
      mentions: [],
      body,
      createdAt,
    };
    const thread: Thread = {
      id: uid(),
      anchor: gap.anchor,
      resolved: false,
      createdAt,
      intent,
      clocks: { resolutionAt: createdAt, intentAt: createdAt, anchorAt: createdAt },
      comments: [comment],
    };
    if (!updateThreads((prev) => [...prev, thread])) return false;
    setActiveId(thread.id);
    void persistAndNotify(comment, undefined, thread.id);
    locateAnchorInDoc(gap.anchor);
    return true;
  };

  const readTextSource = useCallback(async (source: string): Promise<string> => {
    const value = source.trim();
    if (!value) throw new Error('No path or URL provided.');
    if (isHttpUrl(value)) {
      const response = await fetch(value);
      if (!response.ok) throw new Error(`Could not read ${value} (${response.status}).`);
      return response.text();
    }
    const target = sourceTargetRef.current;
    if (!target || target.kind === 'ado-workitem') throw new Error('No repository source is loaded.');
    if (target.kind === 'github') {
      const { text } = await fetchMarkdown(getToken(), {
        owner: target.owner,
        repo: target.repo,
        ref: target.ref,
        path: value,
        ...(target.commitSha ? { commitSha: target.commitSha } : {}),
      });
      return text;
    }
    return (await fetchSourceDocument({ ...target, path: value }, documentRevision)).text;
  }, [documentRevision]);

  // Load the REVIEW.md policy (#89) that governs the AI reviewer pass. Best-effort:
  // explicit path first, then repo-root REVIEW.md, then the built-in default policy.
  const loadReviewPolicy = useCallback(async (policyPath?: string): Promise<ReviewPolicy> => {
    const candidates = [policyPath?.trim(), 'REVIEW.md'].filter((path): path is string => Boolean(path));
    for (const candidate of candidates) {
      try {
        const text = await readTextSource(candidate);
        if (text && text.trim()) return parseReviewPolicy(text);
      } catch {
        /* no REVIEW.md, or unreadable — try the next candidate */
      }
    }
    return DEFAULT_POLICY;
  }, [readTextSource]);

  const loadSkillSource = useCallback(async (explicitSource?: string): Promise<SkillSource | null> => {
    const candidates = explicitSource?.trim() ? [explicitSource.trim()] : parseSkillPaths(SKILL_PATHS);
    for (const candidate of candidates) {
      try {
        const text = await readTextSource(candidate);
        const skill = resolveSkillFromText(text, candidate);
        if (skill) return skill;
      } catch {
        /* unreadable skill candidate — try the next configured source */
      }
    }
    return null;
  }, [readTextSource]);

  // Accept an AI review finding (#43): promote the ephemeral draft finding into a
  // real thread at its anchor, carrying its intent and (optionally) a suggested fix
  // (#35). When the finding carries a proposed replacement and the document is
  // writable here, the fix is applied to the document immediately so the change is
  // visible in the preview (#108) — the promoted thread records it as applied and
  // resolved. When the source is read-only, the thread still carries the ready
  // suggestion so the user can apply it after signing in. Nothing was persisted or
  // notified before this explicit acceptance.
  const acceptReviewFinding = (finding: ReviewFinding): FindingAcceptanceOutcome => {
    if (!finding.anchor || !commentAuthor || sourceLoading || !canComment) return 'failed';
    const localOnly =
      !sourceTarget ||
      !canPublishReview ||
      (sourceTarget.kind !== 'ado-workitem' && commentAuthorIdentityKeys.length === 0);
    const createdAt = now();
    const grounding = finding.skillName ? `\n\n_Grounded by skill: ${finding.skillName}_` : '';
    const body = `**AI review (${finding.pass}): ${finding.title}**\n\n${finding.rationale}${grounding}`;
    const comment: Comment = {
      id: uid(),
      author: commentAuthor,
      authorLogin: commentAuthorLogin,
      authorIdentityKeys: commentAuthorIdentityKeys,
      identityVersion: 1,
      ...(localOnly ? { localOnly: true as const } : {}),
      mentions: [],
      body,
      createdAt,
    };

    // If the finding proposes a replacement and this source is writable, apply it
    // to the document now so the user sees exactly how the text changes.
    const applied =
      finding.replacement && canApplySuggestion
        ? htmlSource
          ? applyHtmlSuggestion(markdownRef.current, finding.anchor, finding.replacement)
          : applySuggestion(markdownRef.current, finding.anchor, finding.replacement)
        : null;

    const thread: Thread = {
      id: uid(),
      anchor: finding.anchor,
      resolved: Boolean(applied?.ok),
      createdAt,
      intent: finding.intent,
      ...(finding.replacement
        ? {
            suggestion: {
              replacement: finding.replacement,
              origin: 'ai' as const,
              ...(finding.skillName ? { skillName: finding.skillName } : {}),
              ...(applied?.ok ? { appliedAt: createdAt } : {}),
            },
          }
        : {}),
      clocks: {
        resolutionAt: createdAt,
        intentAt: createdAt,
        anchorAt: createdAt,
      },
      comments: [comment],
    };
    if (!updateThreads((prev) => [...prev, thread])) return 'failed';
    setActiveId(thread.id);
    void persistAndNotify(comment, undefined, thread.id);

    if (applied?.ok) {
      // Commit the text change through the same path as a manual doc edit so the
      // preview updates and the change follows the normal save flow.
      const nextText = 'html' in applied ? applied.html : applied.text;
      setMarkdown(nextText);
      setDraftMd(nextText);
      if (sourceTarget && canWriteSource && sourceIsWritable(sourceTarget)) setSaveChoice(true);
      else if (sourceTarget) {
        setStatus(
          canWriteSource
            ? 'Proposed fix applied; this source is not pinned to a writable branch, so it stays local.'
            : 'Proposed fix applied locally. Sign in to commit it to the source repository.'
        );
      } else {
        setStatus('Proposed fix applied to the sample document.');
      }
    } else {
      if (finding.replacement && canApplySuggestion) {
        // We wanted to apply but the anchor no longer matches — surface it rather
        // than silently doing nothing; the thread still carries the suggestion.
        setStatus(
          'That proposed fix no longer matches the document — accepted as a suggestion you can apply from the thread.'
        );
      }
      locateAnchorInDoc(finding.anchor);
    }
    return applied?.ok ? 'applied_to_draft' : 'posted_as_thread';
  };

  // Jump the main document view to an anchored span and flash a transient
  // highlight (CSS Custom Highlight API, best-effort). Used by draft AI findings
  // (#43) and AI-readiness gaps (#44) — neither is a painted thread, so there's no
  // data-thread-id to scroll to; we re-locate the anchor in the rendered doc.
  const locateAnchorInDoc = (anchor?: Anchor) => {
    if (editing || !anchor) return;
    const root = bodyRef.current;
    if (!root) return;
    const located = locateAnchor(root, anchor);
    if (!located) return;
    const { range } = located;
    const el =
      range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : (range.startContainer as HTMLElement);
    const rect = range.getClientRects()[0];
    if (rect && htmlSource && htmlFrameRef.current) {
      const frameRect = htmlFrameRef.current.getBoundingClientRect();
      const top = frameRect.top + rect.top * htmlFrameScale;
      const bottom = frameRect.top + rect.bottom * htmlFrameScale;
      if (top < 0 || bottom > window.innerHeight) {
        window.scrollBy({
          top: top - Math.max(24, window.innerHeight * 0.25),
          behavior: 'smooth',
        });
      }
      htmlFrameRef.current.contentWindow?.focus();
    } else if (rect && (rect.top < 0 || rect.bottom > window.innerHeight)) {
      el?.scrollIntoView({ block: 'nearest' });
    }
    try {
      const ownerWindow = root.ownerDocument.defaultView ?? window;
      const HL = (ownerWindow as any).Highlight;
      const highlights = (ownerWindow.CSS as any)?.highlights;
      if (HL && highlights) {
        highlights.set('finding-flash', new HL(range.cloneRange()));
        window.setTimeout(() => highlights.delete('finding-flash'), 1800);
      }
    } catch {
      /* highlight is best-effort — scrolling already succeeded */
    }
  };

  const locateFinding = (finding: ReviewFinding) => locateAnchorInDoc(finding.anchor);
  const locateReadinessGap = (gap: ReadinessGap) => locateAnchorInDoc(gap.anchor);

  const reply = (threadId: string, draftBody: string, draftMentions: MentionReference[]) => {
    if (!commentAuthor || sourceLoading || !canComment) return false;
    const body = draftBody;
    const localOnly =
      !sourceTarget ||
      !canPublishReview ||
      (sourceTarget.kind !== 'ado-workitem' && commentAuthorIdentityKeys.length === 0);
    const mentions = finalizeMentionReferences(
      body,
      draftMentions.map((mention) =>
        localOnly && mention.kind === 'resolved'
          ? {
              kind: 'unresolved' as const,
              start: mention.start,
              length: mention.length,
              text: mention.text,
              handle: mention.handle,
            }
          : mention
      )
    );
    const dispatch = localOnly ? undefined : pendingGitHubDispatch(mentions);
    const comment: Comment = {
      id: uid(),
      author: commentAuthor,
      authorLogin: commentAuthorLogin,
      authorIdentityKeys: commentAuthorIdentityKeys,
      identityVersion: 1,
      ...(localOnly ? { localOnly: true as const } : {}),
      mentions,
      body,
      createdAt: now(),
      ...(dispatch ? { dispatch } : {}),
    };
    const posted = updateThreads((prev) =>
      prev.map((t) =>
        t.id === threadId
          ? {
              ...t,
              comments: [
                ...t.comments,
                comment,
              ],
            }
          : t
      )
    );
    if (!posted) return false;
    void persistAndNotify(comment, draftMentions, threadId);
    return true;
  };
  const resolve = (threadId: string, resolved: boolean) => {
    if (!canMutateShared) return;
    const resolutionAt = now();
    updateThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId && !thread.deletedAt && thread.resolved !== resolved
          ? {
              ...thread,
              resolved,
              clocks: { ...thread.clocks, resolutionAt },
            }
          : thread
      )
    );
  };
  const del = (threadId: string) => {
    const selected = threadsRef.current.find((thread) => thread.id === threadId);
    if (!canMutateShared && !selected?.comments.every((comment) => comment.localOnly)) return;
    const deletedAt = now();
    updateThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId && !thread.deletedAt ? { ...thread, deletedAt } : thread
      )
    );
    if (activeId === threadId) setActiveId(null);
  };
  // Whether the viewer can apply a suggested edit — same gate as editing the doc:
  // the sample is always locally editable; a remote source needs write access.
  const suggestionApplyReason = sourceTarget && !canWriteSource
    ? 'Source write access is required to apply suggestions.'
    : sourceLoading || saving ? 'A source operation is in progress.'
    : adoRecovery || adoReadError ? 'Recover the work-item feedback before applying a suggestion.'
    : (editing && draftMd !== markdown) || recoveredDocument?.sourceKey === docPath
      ? 'Finish or discard the current document draft before applying a suggestion.'
      : undefined;
  const canApplySuggestion = !suggestionApplyReason;
  // Apply a thread's suggested change (#35): re-locate the anchor in the current
  // document, replace exactly that span, mark the suggestion applied, resolve the
  // thread, and run the normal document-save path. A stale anchor is flagged, not
  // applied. Read-only/signed-out sources never write (button is disabled).
  const applyThreadSuggestion = (threadId: string) => {
    if (!canApplySuggestion) return;
    const thread = threadsRef.current.find((t) => t.id === threadId);
    if (!thread?.suggestion || thread.suggestion.appliedAt) return;
    const result = htmlSource
      ? applyHtmlSuggestion(markdownRef.current, thread.anchor, thread.suggestion.replacement)
      : applySuggestion(markdownRef.current, thread.anchor, thread.suggestion.replacement);
    if (!result.ok) {
      setStatus(
        'That suggested edit no longer matches the document — the surrounding text changed too much to apply it automatically.'
      );
      return;
    }
    const at = now();
    const updated = updateThreads((prev) =>
      prev.map((t) =>
        t.id === threadId && !t.deletedAt
          ? {
              ...t,
              resolved: true,
              clocks: { ...t.clocks, resolutionAt: at },
              suggestion: t.suggestion
                ? { ...t.suggestion, appliedAt: at }
                : t.suggestion,
            }
          : t
      )
    );
    if (!updated) return;
    // Commit the text change through the same path as a manual doc edit.
    const nextText = 'html' in result ? result.html : result.text;
    setMarkdown(nextText);
    setDraftMd(nextText);
    if (sourceTarget && canWriteSource && sourceIsWritable(sourceTarget)) setSaveChoice(true);
    else if (sourceTarget) {
      setStatus(
        canWriteSource
          ? 'Suggested edit applied; this source is not pinned to a writable branch, so it stays local.'
          : 'Suggested edit applied locally. Sign in to commit it to the source repository.'
      );
    } else {
      setStatus('Suggested edit applied to the sample document.');
    }
  };
  // Dismiss a suggested change: drop the suggestion but keep the thread open.
  const dismissThreadSuggestion = (threadId: string) => {
    if (!canMutateShared) return;
    updateThreads((prev) =>
      prev.map((t) => {
        if (t.id !== threadId || !t.suggestion || t.suggestion.appliedAt) return t;
        const { suggestion: _dropped, ...rest } = t;
        return rest;
      })
    );
  };
  // AI-draft a suggested edit from a thread's feedback (#63). Asks the configured
  // AI endpoint for a concrete replacement of the anchored text, then attaches it
  // as an AI-provenance suggestion — the existing #35 diff + Apply UI takes over.
  // Never writes to the repo; degrades gracefully when no endpoint is configured.
  const [aiDraftingThreadId, setAiDraftingThreadId] = useState<string | null>(null);
  const draftAiSuggestion = async (threadId: string, activeSkill?: SkillSource | null) => {
    if (!SUGGEST_ENDPOINT) {
      setStatus(
        'AI drafting is not configured on this deployment (set VITE_SUGGEST_ENDPOINT to enable it).'
      );
      return;
    }
    const thread = threadsRef.current.find((t) => t.id === threadId);
    if (!thread || thread.suggestion) return;
    const docTitle =
      sourceTitleText ||
      (sourceTargetRef.current ? sourceDocumentLabel(sourceTargetRef.current) : undefined);
    const request = buildSuggestionRequest(thread.anchor.quote, thread.comments, docTitle, activeSkill?.skill);
    if (request.feedback.length === 0) {
      setStatus('Add a comment describing the change before asking AI to draft a fix.');
      return;
    }
    setAiDraftingThreadId(threadId);
    const finish = beginOperation();
    try {
    setStatus('Asking AI to draft a suggested edit…');
    const result = await requestAiSuggestion(SUGGEST_ENDPOINT, request);
    setAiDraftingThreadId((current) => (current === threadId ? null : current));
    if (!result.ok) {
      setStatus(`AI could not draft a suggested edit (${result.reason}).`);
      return;
    }
    const attached = updateThreads((prev) =>
      prev.map((t) =>
        t.id === threadId && !t.deletedAt && !t.suggestion
          ? {
              ...t,
              suggestion: {
                replacement: result.replacement,
                origin: 'ai' as const,
                ...(activeSkill ? { skillName: activeSkill.skill.name } : {}),
              },
            }
          : t
      )
    );
    if (!attached) return;
    setActiveId(threadId);
    setStatus('AI suggested edit attached to the thread.');
    } finally {
      setAiDraftingThreadId(current => current === threadId ? null : current);
      finish();
    }
  };
  // attributed to the viewer's stable identity key. On GitHub that's the
  // github: node id; on Azure it's the Entra key, or — for an ADO work item where
  // the viewer signed in without an Entra object id — a schema-valid azure-devops:
  // key so reactions work the same on ADO as on GitHub.
  const viewerReactionKey: string | null =
    commentAuthorIdentityKeys[0] ??
    (sourceTarget?.kind === 'ado-workitem'
      ? adoReactionIdentityKey(sourceTarget.organization, azureUser?.login)
      : null);
  const canReact = viewerReactionKey !== null && !adoRecovery && !adoReadError;
  // Include the reaction key so the viewer's own reactions highlight as "mine".
  const reactionViewerKeys = viewerReactionKey
    ? [...new Set([...commentAuthorIdentityKeys, viewerReactionKey])]
    : commentAuthorIdentityKeys;
  const react = (threadId: string, commentId: string, emoji: ReactionEmoji) => {
    const by = viewerReactionKey;
    if (!by) return;
    const at = now();
    updateThreads((prev) =>
      prev.map((thread) =>
        thread.id === threadId && !thread.deletedAt
          ? {
              ...thread,
              comments: thread.comments.map((comment) =>
                comment.id === commentId
                  ? {
                      ...comment,
                      reactions: toggleReaction(comment.reactions, emoji, by, commentAuthor, at),
                    }
                  : comment
              ),
            }
          : thread
      )
    );
  };

  // Click a highlight → activate its thread.
  const onDocClick = (e: React.MouseEvent) => {
    if (selectionClick.current) {
      selectionClick.current = false;
      return;
    }
    const el = (e.target as HTMLElement).closest('[data-thread-id]');
    const id = el?.getAttribute('data-thread-id');
    if (id) focusDiscussion(id);
  };

  useEffect(() => {
    const frame = htmlFrameRef.current;
    const shell = htmlFrameShellRef.current;
    if (!htmlSource) {
      setHtmlFrameHeight(0);
      setHtmlFrameScale(1);
      return;
    }
    if (!frame || !shell) return;
    const doc = frame.contentDocument;
    if (!doc?.body) return;
    bodyRef.current = doc.body as HTMLDivElement;
    const win = frame.contentWindow;
    syncHtmlFrameHeight();
    syncHtmlFrameScale();
    const mouseUp = () => handleMouseUp(win ?? window);
    const keyUp = (event: KeyboardEvent) => {
      if (event.key === 'Shift') handleMouseUp(win ?? window);
    };
    const keyDown = (event: KeyboardEvent) => {
      const id = (event.target as HTMLElement).closest('[data-thread-id]')?.getAttribute('data-thread-id');
      if (id && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        focusDiscussion(id);
      }
      moveDocumentSelection(event as unknown as ReactKeyboardEvent<HTMLDivElement>, win ?? window);
    };
    const click = (event: MouseEvent) => onDocClick(event as unknown as React.MouseEvent);
    doc.body.addEventListener('mouseup', mouseUp);
    doc.body.addEventListener('keyup', keyUp);
    doc.body.addEventListener('keydown', keyDown);
    doc.body.addEventListener('click', click);
    const observer = new ResizeObserver(() => syncHtmlFrameHeight());
    observer.observe(doc.body);
    observer.observe(doc.documentElement);
    return () => {
      doc.body.removeEventListener('mouseup', mouseUp);
      doc.body.removeEventListener('keyup', keyUp);
      doc.body.removeEventListener('keydown', keyDown);
      doc.body.removeEventListener('click', click);
      observer.disconnect();
    };
  }, [htmlSource, docHtml, handleMouseUp, focusDiscussion, htmlFrameLoadCount, syncHtmlFrameHeight, syncHtmlFrameScale]);

  // ---- Edit doc (demonstrates re-anchoring) ----
  const startEdit = () => {
    if (sourceLoading) return;
    if (recoveredDocument?.sourceKey === docPath) {
      setDocumentRecoveryOpen(true);
      return;
    }
    if (compose && (composeText.trim() || (composeSuggest && composeReplacement !== compose.anchor.quote))) {
      setStatus('Your unsent comment is still open in the comments rail.');
      composerHost?.querySelector('textarea')?.focus();
      return;
    }
    if (sourceTarget && !canWriteSource) {
      setStatus('Sign in before editing a remotely loaded document.');
      return;
    }
    setDraftMd(markdown);
    setEditing(true);
    setCompose(null);
  };
  const saveEdit = () => {
    setMarkdown(draftMd);
    setEditing(false);
    if (sourceTarget && canWriteSource && sourceIsWritable(sourceTarget)) setSaveChoice(true);
    else if (sourceTarget) {
      setStatus(
        canWriteSource
          ? 'This source is not pinned to a writable branch; the edit remains local.'
          : 'Document edit saved locally. Sign in to commit it to the source repository.'
      );
    }
  };
  const exitEdit = () => {
    cacheSourceInput();
    if (draftMd !== markdown) setRecoveredDocument({ sourceKey: docPath, markdown: draftMd });
    setEditing(false);
  };
  // Discard the in-progress document edit and leave edit mode without saving.
  // Provider-agnostic (GitHub and ADO): it only reverts the local draft, never
  // touches the source. Confirms first when there are unsaved changes.
  const cancelEdit = () => {
    if (draftMd !== markdown && !window.confirm('Discard your unsaved edits to this document?')) {
      return;
    }
    const storedText = storedDocumentDraft?.sourceKey === docPath ? storedDocumentDraft.markdown : draftMd;
    if (!forgetDocumentDraft(docPath, storedText)) return;
    setDraftMd(markdown);
    setEditing(false);
    setCompose(null);
    setStatus('Discarded document edits.');
  };

  // Commit the current (edited) Markdown straight to the file on its branch.
  const commitEdit = async () => {
    if (!sourceTarget || !canWriteSource) return;
    const target = sourceTarget;
    const targetKey = sourceStorageKey(target);
    setSaving(true);
    setStatus(
      target.kind === 'ado-workitem'
        ? `Updating Azure DevOps work item #${target.id}…`
        : `Committing ${sourceDocumentLabel(target)} to ${sourceReferenceLabel(target)}…`
    );
    try {
      const revision = await commitSourceDocument(
        target,
        draftMd,
        documentRevision
      );
      if (
        !sourceTargetRef.current ||
        sourceStorageKey(sourceTargetRef.current) !== targetKey
      ) {
        return;
      }
      setDocumentRevision(revision);
      setSavedDraftMd(draftMd);
      forgetDocumentDraft(targetKey, draftMd);
      setSourceReceipt({ sourceKey: targetKey, text: `Document saved to ${sourceProviderName(target)}.`, url: sourceFileUrl(target) });
      setSaveChoice(false);
      setStatus(
        target.kind === 'ado-workitem'
          ? `Updated Azure DevOps work item #${target.id}.`
          : `Committed edit to ${sourceRepositoryLabel(target)}@${sourceReferenceLabel(target)}.`
      );
    } catch (e: any) {
      setStatus(`Commit failed: ${e.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  // Open a pull request with the edited Markdown.
  const prEdit = async () => {
    if (!sourceTarget || !canWriteSource || !sourceSupportsPullRequest(sourceTarget)) return;
    const target = sourceTarget;
    const targetKey = sourceStorageKey(target);
    setSaving(true);
    setStatus('Creating pull request…');
    try {
      const pr = await createSourceDocumentPullRequest(
        target,
        draftMd,
        documentRevision,
        {
        title: `DocThread edit: ${sourceDocumentLabel(target)}`,
      });
      if (
        !sourceTargetRef.current ||
        sourceStorageKey(sourceTargetRef.current) !== targetKey
      ) {
        return;
      }
      setSaveChoice(false);
      setStatus(`Opened PR #${pr.number} → ${pr.url}`);
      setSavedDraftMd(draftMd);
      forgetDocumentDraft(targetKey, draftMd);
      setSourceReceipt({ sourceKey: targetKey, text: `Pull request #${pr.number} created; the original source is unchanged.`, url: pr.url });
      try {
        window.open(pr.url, '_blank', 'noopener');
      } catch {
        /* popup blocked — link is in the status bar */
      }
    } catch (e: any) {
      setStatus(`Couldn’t create PR: ${e.message ?? e}`);
    } finally {
      setSaving(false);
    }
  };

  // ---- Recently viewed files ----
  const recordRecent = useCallback((target: SourceTarget) => {
    const entry: RecentEntry = {
      key: sourceStorageKey(target),
      url: sourceFileUrl(target),
      kind: target.kind,
      repoLabel: sourceRepositoryLabel(target),
      docLabel: sourceDocumentLabel(target),
      refLabel: target.kind === 'ado-workitem' ? undefined : sourceReferenceLabel(target),
      ts: Date.now(),
    };
    setRecents((prev) => {
      const next = promoteRecent(prev, entry);
      storeRecents(next);
      return next;
    });
  }, []);

  const toggleRecents = useCallback(() => {
    setRecentsCollapsed((prev) => {
      const next = !prev;
      storeRecentsCollapsed(next);
      return next;
    });
  }, []);

  // ---- Git repository connect ----
  const connectResolvedSource = async (
    inputTarget: SourceTarget,
    generation = sourceLoadGeneration.current + 1,
    leaveApproved = false
  ) => {
    if (!leaveApproved && !mayLeaveSource(() => void connectResolvedSource(inputTarget, undefined, true))) return;
    sourceLoadGeneration.current = generation;
    setSourceProblem('');
    if (!sourceAccessConfigured(inputTarget)) {
      if (generation === sourceLoadGeneration.current) {
        setStatus(`${sourceProviderName(inputTarget)} access is not configured on this deployment.`);
        setSourceProblem(`${sourceProviderName(inputTarget)} is unavailable on this deployment. Use an authorized local instance with this provider enabled.`);
      }
      setSourceLoading(false);
      return;
    }
    setSourceLoading(true);
    try {
      const target = await resolveSourceTarget(inputTarget);
      if (generation !== sourceLoadGeneration.current) return;
      setStatus(
        `Loading ${sourceRepositoryLabel(target)}/${sourceDocumentLabel(
          target
        )}@${sourceReferenceLabel(target)}…`
      );
      const sidecar = await loadSourceSidecar(target);
      if (generation !== sourceLoadGeneration.current) return;
      const loadedTarget: SourceTarget =
        target.kind === 'github' &&
        target.versionType === 'branch' &&
        sidecar.revision
          ? { ...target, commitSha: sidecar.revision }
          : target;
      const document = await fetchSourceDocument(loadedTarget, sidecar.revision);
      if (generation !== sourceLoadGeneration.current) return;
      const md = document.text;
      if (!md) throw new Error('The source returned no document content.');
      const storageKey = sourceStorageKey(loadedTarget);
      const local = loadedTarget.kind === 'ado-workitem' ? loadAdoLocalReview(localStorage, storageKey) : loadLocal(storageKey);
      let loadedThreads: Thread[];
      let recovery: typeof adoRecovery = null;
      let readError = '';
      let unpublishedFeedback = false;
      if (loadedTarget.kind === 'ado-workitem') {
        let adoReview: DocThreadFileV1 | null = null;
        try {
          adoReview = await loadAdoReview(loadedTarget);
        } catch (error: any) {
          readError = String(error?.message ?? error);
        }
        if (generation !== sourceLoadGeneration.current) return;
        loadedThreads = adoReview?.threads ?? local?.threads ?? [];
        if (local?.schemaVersion === 1 && !readError) {
          const shared = adoReview ?? { ...local, threads: [] };
          try {
            const combined = combineAdoReviewCopies(local, shared);
            if (!sameReviewThreads(combined, shared)) recovery = { sourceKey: storageKey, local, shared };
          } catch {
            recovery = { sourceKey: storageKey, local, shared };
          }
        }
      } else {
        const combinedFile =
          sidecar.file && local?.schemaVersion === 2
            ? mergeDocThreadFiles(local, sidecar.file, { target: 'local' })
            : sidecar.file ?? (local?.schemaVersion === 2 ? local : null);
        loadedThreads = combinedFile?.threads ?? local?.threads ?? [];
        unpublishedFeedback = !sameReviewThreads({ threads: loadedThreads }, sidecar.file ?? { threads: [] });
      }
      sourceTargetRef.current = loadedTarget;
      sidecarRevisionRef.current = sidecar.revision;
      threadsRef.current = loadedThreads;
      setSourceTarget(loadedTarget);
      setAdoRecovery(recovery);
      setAdoRecoveryOpen(false);
      setAdoRecoveryError('');
      setAdoReadError(readError);
      setSourcePickerOpen(false);
      setPendingMicrosoftSource(null);
      setGitHubSourceChoices([]);
      setSidecarRevision(sidecar.revision);
      setDocumentRevision(document?.revision ?? null);
      setDocumentFormat(documentFormatForSource(loadedTarget));
      suppressLocalLoad.current = true;
      setDocPath(storageKey);
      setMarkdown(md);
      setDraftMd(md);
      setSavedDraftMd(md);
      findDocumentDraft(storageKey, md);
      setSourceReceipt(null);
      restoreSourceInput(storageKey);
      setFeedbackNotice({
        sourceKey: storageKey,
        version: ++feedbackVersion.current,
        phase: unpublishedFeedback
          ? loadedThreads.some(thread => thread.comments.some(comment => comment.localOnly)) ? 'local' : 'pending'
          : 'loaded',
      });
      setNotificationNotice(null);
      setLocalSaveError('');
      setEditing(false);
      setSaveChoice(false);
      setThreads(loadedThreads);
      setSourceRev(0);
      if (!recovery && !readError && (loadedThreads.length > 0 || local)) {
        saveLocal(reviewFile(storageKey, loadedThreads, loadedTarget, md), storageKey);
      }
      setActiveId(null);
      setThreadFocusRequest(null);
      if (loadedTarget.kind !== 'github') await refreshAzureAuth();
      if (generation !== sourceLoadGeneration.current) return;
      recordRecent(loadedTarget);
      setStatus(
        `Loaded ${sourceDocumentLabel(target)} from ${sourceProviderName(target)} (${loadedThreads.filter((thread) => !thread.deletedAt).length} threads).`
      );
      return true;
    } catch (e: any) {
      if (generation === sourceLoadGeneration.current) {
        if (e instanceof ProviderError && e.kind === 'signin-required') {
          setPendingMicrosoftSource(inputTarget);
        }
        setStatus(`${sourceProviderName(inputTarget)} error: ${e.message ?? e}`);
        setSourceProblem(String(e.message ?? e));
      }
    } finally {
      if (generation === sourceLoadGeneration.current) setSourceLoading(false);
    }
  };

  const connectSource = async (value = sourceUrl, leaveApproved = false) => {
    if (!leaveApproved && !mayLeaveSource(() => void connectSource(value, true))) return;
    const generation = ++sourceLoadGeneration.current;
    setSourceProblem('');
    setSourceLoading(true);
    const nonGitHub = parseAzureReposUrl(value) ?? parseAdoWorkItemUrl(value);
    if (nonGitHub) {
      return await connectResolvedSource(nonGitHub, generation, true);
    }
    try {
      setStatus('Resolving the exact GitHub ref and file…');
      const resolution = await resolveGitHubSourceUrl(value, executeGitHubGraphQL);
      if (generation !== sourceLoadGeneration.current) return;
      if (resolution.status === 'ambiguous') {
        setSourcePickerOpen(false);
        setGitHubSourceChoices(resolution.candidates);
        setStatus('This GitHub URL matches more than one exact ref and path. Choose one.');
        return;
      }
      return await connectResolvedSource(resolution.target, generation, true);
    } catch (error: any) {
      if (generation === sourceLoadGeneration.current) {
        setStatus(
          `GitHub source error: ${error?.message ?? 'Use a GitHub blob URL for one Markdown file.'}`
        );
        setSourceProblem(String(error?.message ?? 'Use a GitHub blob URL for one Markdown file.'));
      }
    } finally {
      if (generation === sourceLoadGeneration.current) setSourceLoading(false);
    }
  };

  const saveReview = async () => {
    if (!sourceTarget || !canSaveReview) return;
    const target = sourceTarget;
    const receipt = { sourceKey: sourceStorageKey(target), version: feedbackVersion.current };
    const finish = beginOperation();
    setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'saving' }));
    try {
      const file = reviewFile(docPath, threadsRef.current, target, markdownRef.current);
      if (target.kind === 'ado-workitem') {
        if (file.schemaVersion !== 1) throw new Error('ADO review payload must be schema-v1.');
        await saveAdoReview(target, file);
        if (sourceTargetRef.current && sourceStorageKey(sourceTargetRef.current) === sourceStorageKey(target)) {
          setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'saved' }));
        }
        return;
      }
      const saved = await saveSourceSidecar(
        target,
        file,
        sidecarRevisionRef.current
      );
      adoptSavedSidecar(saved, target);
      if (sourceTargetRef.current && sourceStorageKey(sourceTargetRef.current) === sourceStorageKey(target)) {
        setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'saved' }));
      }
    } catch (e: any) {
      setFeedbackNotice(current => acceptFeedbackOutcome(current, { ...receipt, phase: 'failed', error: String(e.message ?? e) }));
    } finally {
      finish();
    }
  };

  const loadSample = (leaveApproved = false) => {
    if (!leaveApproved && !mayLeaveSource(() => loadSample(true))) return;
    setSourcePickerOpen(false);
    sourceLoadGeneration.current += 1;
    sourceTargetRef.current = null;
    sidecarRevisionRef.current = null;
    setSourceTarget(null);
    setAdoRecovery(null);
    setAdoRecoveryOpen(false);
    setAdoReadError('');
    setAdoRecoveryError('');
    setPendingMicrosoftSource(null);
    setSidecarRevision(null);
    setDocumentRevision(null);
    suppressLocalLoad.current = true;
    setDocPath('sample');
    setDocumentFormat('markdown');
    setMarkdown(SAMPLE_DOC);
    setDraftMd(SAMPLE_DOC);
    setSavedDraftMd(SAMPLE_DOC);
    findDocumentDraft('sample', SAMPLE_DOC);
    setSourceReceipt(null);
    setSourceProblem('');
    restoreSourceInput('sample');
    setFeedbackNotice({ sourceKey: 'sample', version: ++feedbackVersion.current, phase: 'local' });
    setNotificationNotice(null);
    setLocalSaveError('');
    const sampleThreads = loadSampleThreads();
    threadsRef.current = sampleThreads;
    setThreads(sampleThreads);
    setSourceRev(0);
    setActiveId(null);
    setThreadFocusRequest(null);
    setEditing(false);
    setSaveChoice(false);
    setStatus('Sample document opened.');
  };

  const deepLinkStarted = useRef(false);
  // Focus a specific review thread requested via the `thread` deep-link param.
  // The document highlight scroll is handled by the scroll-to-active effect once
  // activeId is set; we defer a tick so anchored highlights have painted first.
  // A missing/orphaned id degrades gracefully to a status notice — never a blank app.
  const focusDeepLinkThread = (threadId: string) => {
    const exists = threadsRef.current.some(
      (thread) => thread.id === threadId && !thread.deletedAt
    );
    if (!exists) {
      setStatus(
        'That comment link points to a thread that isn’t in this document — it may have been resolved, deleted, or is on a different version.'
      );
      return;
    }
    focusDiscussion(threadId);
  };
  useEffect(() => {
    if (deepLinkStarted.current) return;
    deepLinkStarted.current = true;
    const params = new URLSearchParams(window.location.search);
    const threadParam = readThreadParam(window.location.search);
    if (params.has('targetVersion') || params.has('target')) {
      const generation = ++sourceLoadGeneration.current;
      setSourceLoading(true);
      void (async () => {
        try {
          setStatus('Verifying the canonical GitHub target…');
          const decoded = decodeGitHubTargetDeepLinkParams(params);
          setSourceUrl(sourceFileUrl(decoded));
          const verified = await verifyGitHubSourceTarget(decoded, executeGitHubGraphQL);
          if (generation !== sourceLoadGeneration.current) return;
          setSourceUrl(sourceFileUrl(verified));
          const loaded = await connectResolvedSource(verified, generation, true);
          if (generation !== sourceLoadGeneration.current) return;
          if (loaded && threadParam) focusDeepLinkThread(threadParam);
        } catch (error: any) {
          if (generation === sourceLoadGeneration.current) {
            setStatus(`GitHub deep-link error: ${error?.message ?? error}`);
            setSourceProblem(String(error?.message ?? error));
          }
        } finally {
          if (generation === sourceLoadGeneration.current) setSourceLoading(false);
        }
      })();
      return;
    }
    const documentUrl = params.get('doc');
    if (!documentUrl) {
      // No source in the link (e.g. the built-in sample). Threads are already
      // loaded in initial state, so we can focus the requested one directly.
      if (threadParam) focusDeepLinkThread(threadParam);
      return;
    }
    setSourceUrl(documentUrl);
    if (threadParam) {
      void connectSource(documentUrl).then((loaded) => { if (loaded) focusDeepLinkThread(threadParam); });
    } else {
      void connectSource(documentUrl);
    }
    // The deep link is intentionally consumed once on initial mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build a shareable deep link that opens this document and focuses one thread.
  const buildThreadLink = (threadId: string): string => {
    const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString();
    if (sourceTarget) return sourceDeepLink(appUrl, sourceTarget, threadId);
    // Built-in sample / no external source: same-origin link carrying the thread id.
    return withThreadParam(appUrl, threadId);
  };

  // "Share for review" (#111). The invite store is namespaced by the same
  // canonical source key as recents/review storage; the sample uses a fixed key.
  const shareSourceKey = sourceTarget ? sourceStorageKey(sourceTarget) : 'sample';
  const shareDocLabel =
    sourceTitleText ||
    (sourceTarget ? sourceDocumentLabel(sourceTarget) : 'Built-in sample document');
  const shareLink = (() => {
    const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString();
    return sourceTarget ? sourceDeepLink(appUrl, sourceTarget) : appUrl;
  })();
  // Load the locally-stored invites whenever the active document changes.
  useEffect(() => {
    setInvites(loadInvites(shareSourceKey));
  }, [shareSourceKey]);
  const participation = useMemo(
    () => deriveParticipation(invites, visibleThreads),
    [invites, visibleThreads]
  );

  // Send the invitation email to allow-listed addresses and record the invites.
  // The notify relay re-applies the domain allow-list server-side, so disallowed
  // addresses are never contacted even though we also filter here for feedback.
  const shareForReview = useCallback(
    async (
      rawEmails: string,
      message: string
    ): Promise<{ invited: number; rejected: string[]; delivered: boolean; reason?: string }> => {
      const parsed = parseInviteEmails(rawEmails);
      const { allowed, rejected } = partitionInviteEmails(parsed, NOTIFY_ALLOWED_DOMAINS);
      if (allowed.length === 0) {
        return { invited: 0, rejected, delivered: false, reason: 'no recipients within the allowed domains' };
      }
      const { subject, html } = buildShareInviteEmail({
        actor: commentAuthor || 'A DocThread reviewer',
        docLabel: shareDocLabel,
        docUrl: shareLink,
        message,
      });
      const result = await sendMentionEmail(NOTIFY_ENDPOINT, { to: allowed, subject, html });
      const sentAt = now();
      const added = allowed.map((email) => makeInvite(email, sentAt, message));
      setInvites((prev) => {
        const next = mergeInvites(prev, added);
        storeInvites(shareSourceKey, next);
        return next;
      });
      return {
        invited: allowed.length,
        rejected,
        delivered: result.delivered,
        reason: result.reason,
      };
    },
    [commentAuthor, shareDocLabel, shareLink, shareSourceKey]
  );

  const updateRequestReviewDraft = (patch: Partial<ReviewRequestDraft>) => {
    if (reviewDraftSourceKey !== currentSourceKey) return;
    const draft = { ...(reviewDraftMemory.current.get(currentSourceKey) ?? requestReviewDraft), ...patch };
    reviewDraftMemory.current.set(currentSourceKey, draft);
    setRequestReviewDraft(draft);
    setRequestReviewPreview(null);
    setRequestReviewError('');
    try {
      localStorage.setItem(requestReviewDraftStorageKey(currentSourceKey), JSON.stringify(draft));
    } catch {
      setRequestReviewError('Request-review draft could not be saved in this browser; it is retained in this tab.');
    }
  };

  const openRequestReview = () => {
    setRequestReviewError('');
    setRequestReviewPreview(null);
    setRequestReviewOpen(true);
  };

  const previewRequestReview = () => {
    if (!sourceTarget || sourceTarget.kind !== 'github' || !requestReviewChannels[0].available ||
      reviewDraftSourceKey !== currentSourceKey) {
      setRequestReviewError('Open a GitHub document and sign in with GitHub before previewing.');
      return;
    }
    let records: ReviewRequestRecord[];
    try {
      records = latestReviewRequests(currentSourceKey);
    } catch {
      setRequestReviewError('Saved request history is unavailable. Resolve browser storage before creating an issue.');
      return;
    }
    const appUrl = new URL(import.meta.env.BASE_URL, window.location.origin).toString();
    const preview = buildGitHubRequestPreview({
      target: sourceTarget,
      sourceKey: currentSourceKey,
      draft: requestReviewDraft,
      records,
      appUrl,
      docThreadLink: sourceDeepLink(appUrl, sourceTarget),
    });
    const errors = validateGitHubRequestPreview(preview);
    if (preview.duplicate && preview.duplicate.status !== 'unknown') {
      errors.push(`An active request already exists: ${preview.duplicate.externalUrl || preview.duplicate.title}`);
    } else if (preview.duplicate?.status === 'unknown') {
      errors.push('A previous create outcome is unknown. Confirm to look for it in GitHub; absence will not authorize another create.');
    }
    reviewPreviewScope.current = currentReviewScope;
    setRequestReviewPreview(preview);
    setRequestReviewError(errors.join(' '));
  };

  const latestReviewRequests = (sourceKey: string) => mergeReviewRequestRecords(sourceKey,
    loadReviewRequestRecords(localStorage, sourceKey), reviewRequestMemory.current.get(sourceKey) ?? []);

  const persistReviewRequests = (sourceKey: string, update: (latest: ReviewRequestRecord[]) => ReviewRequestRecord[], publish = true) => {
    let latest = reviewRequestMemory.current.get(sourceKey) ?? [];
    let warning = '';
    try { latest = latestReviewRequests(sourceKey); } catch { warning = 'Saved request history could not be read. '; }
    const records = update(latest);
    reviewRequestMemory.current.set(sourceKey, records);
    try { storeReviewRequestRecords(localStorage, sourceKey, records); } catch {
      warning += 'GitHub result is retained in this tab but could not be saved in this browser. Do not blindly retry; verify the issue in GitHub.';
    }
    if (warning) reviewStorageWarnings.current.set(sourceKey, warning);
    else reviewStorageWarnings.current.delete(sourceKey);
    if (publish && sourceKey === reviewRequestScope.current.sourceKey) setReviewRequests(records);
    return warning;
  };

  const submitRequestReview = async () => {
    if (reviewSubmitLock.current || saving || !sourceTarget || sourceTarget.kind !== 'github' ||
      !requestReviewChannels[0].available || !requestReviewPreview ||
      reviewPreviewScope.current !== currentReviewScope || requestReviewPreview.sourceKey !== currentSourceKey ||
      validateGitHubRequestPreview(requestReviewPreview).length > 0) return;
    const target = sourceTarget;
    const sourceKey = currentSourceKey;
    const preview = requestReviewPreview;
    const scope = currentReviewScope;
    const token = getToken();
    const isCurrent = () => reviewRequestScope.current === scope && Boolean(scope.account) && getToken() === token;
    reviewSubmitLock.current = true;
    setRequestReviewBusy(true);
    setRequestReviewError('');
    setStatus('Checking GitHub review request...');
    try {
      const duplicate = findActiveGitHubIssueDuplicate(latestReviewRequests(sourceKey), target);
      if (duplicate && duplicate.status !== 'unknown') {
        if (duplicate.duplicateKey !== preview.duplicateKey) {
          throw new Error('Legacy request needs manual resolution in GitHub; its marker did not identify a ref.');
        }
        if (!duplicate.externalNumber) {
          setRequestReviewError(`An active request already exists: ${duplicate.externalUrl || duplicate.title}`);
          setStatus('Review request already exists, but DocThread cannot update assignees without an issue number.');
          return;
        }
        const currentIssue = await refreshGitHubReviewIssueStatus(fetch, GH_API_BASE, token, target, duplicate.externalNumber);
        if (!isCurrent()) return;
        if (currentIssue.state === 'closed') {
          persistReviewRequests(sourceKey, latest => latest.map(record => record.id === duplicate.id
            ? { ...record, providerState: 'closed', status: 'closed', updatedAt: now() } : record));
          setRequestReviewPreview(null);
          setRequestReviewError('GitHub reports this issue closed. Preview again to request a new review.');
          return;
        }
        let assignment: { confirmedAssignees?: string[]; reviewerAssignmentWarning?: string };
        try {
          assignment = await assignGitHubReviewIssueReviewers(
            fetch,
            GH_API_BASE,
            token,
            target,
            duplicate.externalNumber,
            preview.reviewers,
            isCurrent
          );
        } catch (error: any) {
          assignment = { reviewerAssignmentWarning: `Assignee addition could not be confirmed: ${error?.message ?? error}` };
        }
        const updatedAt = now();
        reviewRefreshVersions.current.delete(`${sourceKey}:${duplicate.id}`);
        const storageWarning = persistReviewRequests(sourceKey, latest => latest.map(record => record.id !== duplicate.id ? record : {
          ...record,
          requestedReviewers: parseReviewerHandles([...record.requestedReviewers, ...preview.reviewers].join(' ')),
          confirmedAssignees: assignment.confirmedAssignees ?? currentIssue.confirmedAssignees,
          assignmentWarning: assignment.reviewerAssignmentWarning,
          providerState: 'open',
          status: 'requested',
          updatedAt,
          lastRefreshAt: updatedAt,
        }), isCurrent());
        if (!isCurrent()) return;
        setSourceReceipt({
          sourceKey,
          text: assignment.reviewerAssignmentWarning
            ? `GitHub Issue #${duplicate.externalNumber} is still the active review request, but assignee update needs attention.`
            : `Assignee request completed on GitHub Issue #${duplicate.externalNumber}; existing assignees were retained.`,
          url: duplicate.externalUrl,
        });
        setStatus(storageWarning || assignment.reviewerAssignmentWarning || `Added requested assignees on GitHub Issue #${duplicate.externalNumber}.`);
        setRequestReviewPreview(null);
        setRequestReviewOpen(false);
        return;
      }
      let result = duplicate?.status === 'unknown'
        ? await reconcileUnknownGitHubReviewIssue(fetch, GH_API_BASE, token, target, ghUser!.login, duplicate.duplicateKey)
        : null;
      if (!isCurrent()) return;
      if (duplicate?.status === 'unknown' && !result) {
        throw new Error('No matching issue was found, but the previous write remains uncertain. Resolve it manually in GitHub; no new issue was created.');
      }
      result ??= await createGitHubReviewIssue(fetch, GH_API_BASE, token, target, {
        title: preview.title,
        body: preview.body,
        reviewers: preview.reviewers,
        isCurrent,
      });
      const recordedAt = now();
      const record = makeGitHubReviewRecord({
        id: duplicate?.id ?? `rr-github-${result.number}`,
        sourceKey,
        sourceBranch: target.ref,
        preview,
        externalId: result.id,
        externalNumber: result.number,
        externalUrl: result.url,
        providerState: result.state,
        assignmentWarning: result.reviewerAssignmentWarning,
        confirmedAssignees: result.confirmedAssignees,
        nowIso: recordedAt,
      });
      const storageWarning = persistReviewRequests(sourceKey, latest => {
        const previous = latest.find(entry => entry.id === record.id || entry.externalNumber === record.externalNumber);
        return upsertReviewRequestRecord(latest, { ...record, id: previous?.id ?? record.id, hidden: previous?.hidden ?? false });
      }, isCurrent());
      if (!isCurrent()) return;
      setRequestReviewPreview(null);
      setRequestReviewOpen(false);
      setSourceReceipt({
        sourceKey,
        text: result.duplicate
          ? `Existing GitHub Issue #${result.number} linked as the active review request.`
          : result.reviewerAssignmentWarning
            ? `GitHub Issue #${result.number} was created, but reviewer assignment needs attention.`
            : `Review requested in GitHub Issue #${result.number}.`,
        url: result.url,
      });
      setStatus(
        storageWarning || (result.duplicate
          ? `Linked existing GitHub Issue #${result.number}.`
          : result.reviewerAssignmentWarning
            ? `Created GitHub Issue #${result.number}; reviewer assignment needs attention: ${result.reviewerAssignmentWarning}`
          : `Created GitHub review request Issue #${result.number}.`)
      );
      try {
        window.open(result.url, '_blank', 'noopener');
      } catch {
        /* The source receipt remains available when the popup is blocked. */
      }
    } catch (error: any) {
      if (error instanceof RequestReviewProviderError && error.category === 'unknown-outcome') {
        const unknownAt = now();
        const unknown = makeUnknownGitHubIssueRecord({
          id: `rr-unknown-${unknownAt}`,
          sourceKey,
          sourceBranch: target.ref,
          preview,
          nowIso: unknownAt,
          staleReason: error.message,
        });
        persistReviewRequests(sourceKey, latest => upsertReviewRequestRecord(latest, unknown), isCurrent());
        if (!isCurrent()) return;
        setRequestReviewError('GitHub issue creation outcome is unknown. Confirm again to reconcile; no blind create retry is allowed.');
        setStatus('GitHub review request outcome is unknown. Your draft is still available.');
      } else {
        if (!isCurrent()) return;
        setRequestReviewError(`GitHub review request failed: ${error?.message ?? error}`);
        setStatus('GitHub review request failed. Your draft is still available.');
      }
    } finally {
      reviewSubmitLock.current = false;
      setRequestReviewBusy(false);
    }
  };

  const refreshReviewRequest = async (record: ReviewRequestRecord, silent = false) => {
    if (!sourceTarget || sourceTarget.kind !== 'github' || !ghUser || record.sourceKey !== currentSourceKey ||
      record.channel !== 'github-issue' || !record.externalNumber) {
      if (!silent) setStatus('Only confirmed GitHub Issue review requests can be refreshed from the provider.');
      return;
    }
    const scope = currentReviewScope;
    const refreshKey = `${record.sourceKey}:${record.id}`;
    const version = {};
    reviewRefreshVersions.current.set(refreshKey, version);
    const current = () => reviewRequestScope.current === scope && reviewRefreshVersions.current.get(refreshKey) === version;
    try {
      const result = await refreshGitHubReviewIssueStatus(fetch, GH_API_BASE, getToken(), sourceTarget, record.externalNumber);
      if (!current()) return;
      const refreshedAt = now();
      persistReviewRequests(
        record.sourceKey,
        latest => latest.map(entry => entry.id !== record.id ? entry : {
          ...entry,
          status: mapGitHubIssueStatus(result.state),
          providerState: result.state,
          externalId: result.id,
          externalNumber: result.number,
          externalUrl: result.url,
          confirmedAssignees: result.confirmedAssignees,
          updatedAt: refreshedAt,
          lastRefreshAt: refreshedAt,
          staleReason: undefined,
        })
      );
      if (!silent) setStatus(`GitHub Issue #${result.number} status refreshed.`);
    } catch (error: any) {
      if (!current()) return;
      const refreshedAt = now();
      persistReviewRequests(
        record.sourceKey,
        latest => latest.map(entry => entry.id !== record.id ? entry : {
          ...entry,
          status: entry.providerState && entry.providerState !== 'unknown' ? 'stale' : 'unknown',
          updatedAt: refreshedAt,
          lastRefreshAt: refreshedAt,
          staleReason: error?.message ?? 'GitHub issue status could not be refreshed.',
        })
      );
      if (!silent) setStatus('Review request status is stale; the last confirmed provider state was preserved.');
    }
  };

  const toggleReviewRequestHidden = (record: ReviewRequestRecord) => {
    if (record.sourceKey !== currentSourceKey) return;
    persistReviewRequests(
      record.sourceKey,
      latest => latest.map(entry => entry.id !== record.id ? entry : {
        ...entry,
        hidden: !entry.hidden,
        updatedAt: now(),
      })
    );
    setStatus(record.hidden ? 'Review request shown in this browser.' : 'Hidden from this browser. The GitHub issue is unchanged and still prevents duplicate requests while open.');
  };

  const sourceTitle = sourceTarget
    ? `${sourceRepositoryLabel(sourceTarget)}/${sourceDocumentLabel(sourceTarget)}${
        sourceTarget.kind === 'ado-workitem' ? '' : ` · ${sourceReferenceLabel(sourceTarget)}`
      }${
        documentRevision
          ? ` · ${sourceTarget.kind === 'ado-workitem' ? 'work item' : 'file'} revision ${documentRevision}`
          : ''
      }`
    : 'Built-in sample document · local review storage';
  const recoveryText = [
    `Source: ${sourceTitle}`,
    'Unsent comment:', composeText,
    ...(composeSuggest ? ['Proposed replacement:', composeReplacement] : []),
    'Unsent replies:', ...Object.entries(replyDrafts).filter(([, draft]) => draft.body.trim()).map(([id, draft]) => `${threads.find(thread => thread.id === id)?.anchor.quote || id}\n${draft.body}`),
    'Document draft:', currentDocumentDraft,
    'Feedback:', ...visibleThreads.map(thread => `${thread.anchor.quote}\n${thread.comments.map(comment => `${comment.author}: ${comment.body}`).join('\n')}`),
  ].join('\n\n');
  const exportRecovery = () => {
    const url = URL.createObjectURL(new Blob([recoveryText], { type: 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'docthread-unsent-input.txt';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const reviewCopyText = (file: DocThreadFileV1) => file.threads.map(thread => `${thread.anchor.quote}\n${thread.comments.map(comment => `${comment.author}: ${comment.body}`).join('\n')}`).join('\n\n');
  const recoverAdoFeedback = () => {
    if (!adoRecovery || adoRecovery.sourceKey !== docPath) return;
    try {
      const recovered = combineAdoReviewCopies(adoRecovery.local, adoRecovery.shared);
      saveLocal(recovered, docPath);
      threadsRef.current = recovered.threads;
      setThreads(recovered.threads);
      setSourceRev(0);
      setFeedbackNotice({ sourceKey: docPath, version: ++feedbackVersion.current, phase: 'local' });
      setAdoRecovery(null);
      setAdoRecoveryOpen(false);
      setAdoRecoveryError('');
      setStatus('Feedback recovered in this browser. Use Save review to share it.');
    } catch (error: any) {
      setAdoRecoveryError(`The copies could not be combined: ${error?.message ?? error}. Both copies have been kept.`);
    }
  };

  return (
    <div className={`app ${editing ? 'editing' : 'reading'} ${htmlSource ? 'html-source' : ''}`}>
      <div className="topbar app-header">
        <div className="brand">
          <h1>DocThread</h1>
          <span className="source-context" title={sourceTitle}>
            {sourceTarget ? (
              <>
                <span className="source-repo">
                  {sourceRepositoryLabel(sourceTarget)}
                </span>
                <span aria-hidden>/</span>
                <span className="source-path">{sourceDocumentLabel(sourceTarget)}</span>
                {sourceTarget.kind !== 'ado-workitem' && (
                  <span className="source-ref">@{sourceReferenceLabel(sourceTarget)}</span>
                )}
                {documentRevision && (
                  <code
                    className="source-revision"
                    title={`${sourceTarget.kind === 'ado-workitem' ? 'Work item' : 'File'} revision ${documentRevision}`}
                  >
                    rev {documentRevision.slice(0, 7)}
                  </code>
                )}
              </>
            ) : (
              <>
                <span>Sample</span>
                <span aria-hidden>·</span>
                <span>local</span>
              </>
            )}
          </span>
        </div>
        <div className="header-actions">
          <button onClick={() => setShareOpen(true)}>Share</button>
          <button
            className="primary"
            onClick={openRequestReview}
            disabled={sourceLoading || saving || operationCount > 0}
          >
            Request review
          </button>
          <span className="action-divider" aria-hidden />
          <details
            className="tools-menu"
            onClick={(event) => {
              if ((event.target as HTMLElement).closest('button')) event.currentTarget.open = false;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.currentTarget.open = false;
                event.currentTarget.querySelector('summary')?.focus();
              }
            }}
          >
            <summary>Tools</summary>
            <div className="tools-menu-items">
              <button
                onClick={startEdit}
                disabled={editing || Boolean(sourceTarget && !canWriteSource)}
                title={sourceTarget && !canWriteSource ? 'Source write access is required' : undefined}
              >
                Edit document
              </button>
              <button onClick={() => setSourcePickerOpen(true)} disabled={sourceLoading || operationCount > 0 || saving}>Open document</button>
              {(unsentInput || feedbackNotice.phase === 'failed') && <button onClick={() => setRecoveryOpen(true)}>Inspect / export unsent input</button>}
              <div ref={setToolsHost} />
            </div>
          </details>
          {editing && (
            <>
              <button onClick={saveEdit}>Apply draft</button>
              <button onClick={exitEdit}>Exit editor</button>
              <button onClick={cancelEdit}>Discard edits</button>
            </>
          )}
          {editing && (
            <div className="view-mode" role="group" aria-label="Editor view">
              {(
                [
                  { mode: 'editor' as const, label: 'Editor', title: 'Editor only' },
                  { mode: 'split' as const, label: 'Split', title: 'Editor and live preview side by side' },
                  { mode: 'preview' as const, label: 'Preview', title: 'Rendered preview only' },
                ]
              ).map((option) => (
                <button
                  key={option.mode}
                  type="button"
                  className={editorView === option.mode ? 'active' : ''}
                  aria-pressed={editorView === option.mode}
                  title={option.title}
                  onClick={() => chooseEditorView(option.mode)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
          {editing && (
            <label
              className="spellcheck-toggle"
              title="Spell-check the editor (turn off for code-heavy documents)"
            >
              <input type="checkbox" checked={spellCheckOn} onChange={toggleSpellCheck} />
              <span className="wide-label">Spell check</span>
              <span className="narrow-label" aria-hidden>
                Spell
              </span>
            </label>
          )}
          <NotificationBell
            items={inboxItems}
            readState={inboxRead}
            disabled={inboxDisabled}
            onOpenItem={openInboxItem}
            onMarkAllRead={markInboxAllRead}
          />
        </div>
        <div className="account-slot">
          {usingAzure ? (
            azureUser ? (
              <span className="auth-status" title={`Signed in for Azure Repos as ${azureUser.login}`}>
                <span className="account-label">
                  <span className="account-prefix">Signed in as </span>
                  <strong>{azureUser.name || azureUser.login}</strong>
                </span>
                <button onClick={signOutOfAzure} title="Sign out of Microsoft Entra">
                  Sign out
                </button>
              </span>
            ) : (
              <span className="auth-status">
                {AZURE_AUTH_MODE === 'static' && GRAPH_TRANSPORT === 'off' ? (
                  <span title="Set VITE_AZURE_CLIENT_ID to enable hosted Azure Repos sign-in">
                    Azure Repos sign-in not configured
                  </span>
                ) : (
                  <>
                    <span className="auth-label">
                      {azureAuthChecked ? 'Not signed in' : 'Checking sign-in…'}
                    </span>
                    <button onClick={signInToAzure}>
                      {AZURE_AUTH_MODE === 'dev' && azureLoginStarted
                        ? 'Recheck sign-in'
                        : 'Sign in with Microsoft'}
                    </button>
                  </>
                )}
              </span>
            )
          ) : ghUser ? (
            <span className="auth-status" title={`Signed in to GitHub as ${ghUser.login}`}>
              {ghUser.avatarUrl && (
                <img src={ghUser.avatarUrl} alt="" width={24} height={24} />
              )}
              <span className="account-label">
                <span className="account-prefix">Signed in as </span>
                <strong>{ghUser.login}</strong>
              </span>
              <button onClick={signOut} title="Sign out of GitHub">
                Sign out
              </button>
            </span>
          ) : (
            <span className="auth-status">
              {AUTH_MODE === 'static' ? (
                <span title="Set VITE_GH_CLIENT_ID and VITE_OAUTH_PROXY to enable hosted sign-in">
                  GitHub sign-in not configured
                </span>
              ) : (
                <>
                  {deviceCode ? (
                    <>
                      <span>Waiting for GitHub authorization…</span>
                      <button onClick={cancelDeviceLogin}>Cancel</button>
                    </>
                  ) : (
                    <>
                      <span className="auth-label">
                        {authChecked ? 'Not signed in' : 'Checking sign-in…'}
                      </span>
                      <button onClick={signIn}>
                        {AUTH_MODE === 'dev' && devLoginStarted
                          ? 'Recheck sign-in'
                          : 'Sign in with GitHub'}
                      </button>
                    </>
                  )}
                </>
              )}
            </span>
          )}
        </div>
      </div>

      {deviceCode && (
        <section className="device-flow" aria-labelledby="device-flow-title">
          <div>
            <h2 id="device-flow-title">Your GitHub sign-in code</h2>
            <div className="device-code-row">
              <code>{deviceCode.userCode}</code>
              <button type="button" onClick={() => void copyDeviceCode()}>
                {deviceCopied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <p>
              Expires in {Math.floor(deviceSecondsLeft / 60)}:
              {String(deviceSecondsLeft % 60).padStart(2, '0')}. Waiting for authorization…
            </p>
          </div>
          <div className="device-flow-actions">
            <button className="primary" type="button" onClick={openDevicePage}>
              Open GitHub to enter it
            </button>
            <button type="button" onClick={requestNewDeviceCode}>
              Get a new code
            </button>
            <a href={deviceCode.verificationUri} target="_blank" rel="noreferrer">
              Open link directly
            </a>
          </div>
        </section>
      )}

      {status && !sourceProblem && <div className="banner" role="status">{status}</div>}
      {sourceProblem && (
        <div className="banner source-problem" role="alert">
          <strong>Could not open the requested document.</strong>
          <code>{sourceUrl}</code>
          <span>{sourceProblem}</span>
          <button onClick={() => setSourcePickerOpen(true)}>Check document link</button>
        </div>
      )}
      {localSaveError && <div className="banner" role="alert">{localSaveError}</div>}
      {(editing ? draftMd : markdown) !== savedDraftMd && (
        <div className="review-storage" role="status">
          <span>{storedDocumentDraft?.sourceKey === docPath && storedDocumentDraft.markdown === (editing ? draftMd : markdown) ? 'Document draft saved in this browser; source unchanged.' : 'Document changes are only in this tab.'}</span>
          {!editing && sourceTarget && canWriteSource && <button onClick={() => setSaveChoice(true)}>Save to source</button>}
          <button onClick={() => setRecoveryOpen(true)}>Inspect / export</button>
        </div>
      )}
      {documentDraftProblem?.sourceKey === docPath && <div className="banner" role="alert">{documentDraftProblem.text}</div>}
      {recoveredDocument?.sourceKey === docPath && (
        <div className="review-storage" role="status">
          <span>A document draft is available for this source.</span>
          <button onClick={() => setDocumentRecoveryOpen(true)}>Compare draft</button>
        </div>
      )}
        <div className="review-storage review-workspace-bar">
          <span role="status">{localSaveError ? 'Feedback not posted' : feedbackMessage(feedbackNotice, sourceTarget ? sourceProviderName(sourceTarget) : '')}</span>
          {sourceTarget && <button onClick={saveReview} disabled={!canSaveReview || operationCount > 0 || Boolean(localSaveError)}>{feedbackNotice.phase === 'failed' ? 'Retry feedback save' : 'Save review'}</button>}
          {sourceTarget && !canPublishReview && <span>{sourceIsWritable(sourceTarget) ? 'Sign in with source write access to share feedback.' : 'This version is read-only; new feedback stays in this browser.'}</span>}
          {sourceTarget?.kind === 'ado-workitem' && (
            <label>
              Review storage{' '}
              <select value={adoStoreMode} onChange={(event) => setAdoStoreMode(event.target.value as AdoReviewStoreMode)}>
                <option value="attachment">Attached file</option>
                <option value="discussion">Discussion</option>
              </select>
            </label>
          )}
          <div className="review-controls-host" ref={setReviewControlsHost} />
      </div>
      {reviewRequests.some(record => record.sourceKey === currentSourceKey) && (
        <section className="request-review-summary" aria-label="Review requests">
          <div className="request-review-summary-head">
           <strong>Review requests</strong>
           <label><input type="checkbox" checked={showHiddenReviews} onChange={event => setShowHiddenReviews(event.target.checked)} />Show hidden requests</label>
          </div>
          <ul>
           {reviewRequests.filter(record => record.sourceKey === currentSourceKey && (showHiddenReviews || !record.hidden)).map((record) => (
             <li key={record.id}>
               <div>
                 <strong>{formatReviewRequestStatus(record)}</strong>
                 <span>
                   {record.channel === 'github-issue' ? 'GitHub Issue' : 'GitHub PR'}
                   {record.externalNumber || record.externalId ? ` #${record.externalNumber ?? record.externalId}` : ''} ·{' '}
                   Requested: {record.requestedReviewers.map((reviewer) => `@${reviewer}`).join(', ') || 'none'}
                 </span>
                 <small>
                   {record.hidden ? 'Hidden in this browser; ' : ''}Confirmed assignees: {record.confirmedAssignees?.map(reviewer => `@${reviewer}`).join(', ') || (record.confirmedAssignees ? 'none' : 'not checked')}; last refresh:{' '}
                   {record.lastRefreshAt ? new Date(record.lastRefreshAt).toLocaleString() : 'never'}
                   {record.assignmentWarning ? `; reviewer assignment warning: ${record.assignmentWarning}` : ''}
                   {record.staleReason ? `; stale reason: ${record.staleReason}` : ''}
                 </small>
               </div>
               <div className="request-review-summary-actions">
                 {record.externalUrl && <a href={record.externalUrl} target="_blank" rel="noreferrer">Open</a>}
                 <button type="button" disabled={!ghUser || !record.externalNumber} onClick={() => refreshReviewRequest(record)}>Refresh</button>
                 <button type="button" onClick={() => toggleReviewRequestHidden(record)}>{record.hidden ? 'Show in this browser' : 'Hide from this browser'}</button>
               </div>
             </li>
           ))}
          </ul>
        </section>
      )}
      {sourceReceipt?.sourceKey === docPath && (editing ? draftMd : markdown) === savedDraftMd && <div className="review-storage" role="status"><span>{sourceReceipt.text}</span>{sourceReceipt.url && <a href={sourceReceipt.url} target="_blank" rel="noreferrer">Open source result</a>}</div>}
      {notificationNotice?.sourceKey === docPath && <div className="review-storage" role="status">{notificationNotice.text}</div>}
      {adoRecovery?.sourceKey === docPath && (
        <div className="banner" role="status">
          Local feedback differs from the saved work-item review. Both copies have been kept.{' '}
          <button onClick={() => setAdoRecoveryOpen(true)}>Compare feedback</button>
        </div>
      )}
      {adoReadError && sourceTarget?.kind === 'ado-workitem' && (
        <div className="banner" role="alert">
          Could not read the saved work-item review: {adoReadError}. The local copy has been kept.{' '}
          <button onClick={() => void connectResolvedSource(sourceTarget)}>Retry reading feedback</button>
        </div>
      )}
      {pendingMicrosoftSource && (
        <div className="banner info attribution-banner">
          <span>Microsoft sign-in is required to resolve and load this Azure source.</span>
          <button
            type="button"
            onClick={async () => {
              if (await signInToAzure()) {
                const pending = pendingMicrosoftSource;
                setPendingMicrosoftSource(null);
                await connectResolvedSource(pending);
              }
            }}
          >
            {azureLoginStarted ? 'Recheck Microsoft sign-in' : 'Sign in with Microsoft'}
          </button>
          <button type="button" onClick={() => setPendingMicrosoftSource(null)}>
            Cancel
          </button>
        </div>
      )}
      {sourceTarget &&
        canPublishReview &&
        localOnlyCommentCount > 0 &&
        !attributionDismissed && (
          <div className="banner info attribution-banner">
            <span>
              {localOnlyCommentCount} local comment{localOnlyCommentCount === 1 ? '' : 's'} must be
              attributed before publishing. Existing typed mentions remain unresolved and send no
              notification.
            </span>
            <button type="button" onClick={attributeAndPublish}>
              Attribute and publish as {commentAuthor}
            </button>
            <button type="button" onClick={() => setAttributionDismissed(true)}>
              Keep local
            </button>
          </div>
        )}
      {orphanCount > 0 && (
        <div className="banner">
          ⚠ {orphanCount} comment{orphanCount > 1 ? 's' : ''} could not be re-anchored after edits —
          shown as “text changed” in the panel.
        </div>
      )}

      {editing && visibleThreads.length > 0 && !htmlSource && (
        <div className="banner info">
          🖍 Highlighted text has review comments — edit it to address the feedback shown in the
          panel on the right.
        </div>
      )}
      {editing && visibleThreads.length > 0 && htmlSource && (
        <div className="banner info">
          Editing HTML directly — review threads stay anchored in the rendered preview.
        </div>
      )}

      <div className="main">
        {editing ? (
          <div className={`edit-area mode-${editorView}`}>
            {editorView !== 'preview' && (
              <HighlightedEditor
                value={draftMd}
                onChange={setDraftMd}
                threads={visibleThreads}
                activeId={activeId}
                format={documentFormat}
                spellCheck={spellCheckOn}
                onScrollRatio={editorView === 'split' ? syncPreviewScroll : undefined}
              />
            )}
            {editorView !== 'editor' && (
              <div className="doc preview-pane" ref={previewRef} aria-label="Rendered preview">
                <div className="doc-body">
                  {htmlSource ? (
                    <div
                      className="doc-frame-shell"
                      ref={htmlFrameShellRef}
                      style={htmlFrameHeight ? { height: `${htmlFrameHeight * htmlFrameScale}px` } : undefined}
                    >
                      <iframe
                        ref={htmlFrameRef}
                        className="doc-frame"
                        title="Rendered HTML preview"
                        srcDoc={htmlDraftFrameSrcDoc}
                        style={{ height: `${htmlFrameHeight}px` }}
                        onLoad={() => {
                          syncHtmlFrameHeight();
                          syncHtmlFrameScale();
                          setHtmlFrameLoadCount((count) => count + 1);
                        }}
                      />
                    </div>
                  ) : (
                    <div dangerouslySetInnerHTML={{ __html: renderedDraftHtml }} />
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div
            className="doc"
            ref={docRef}
            tabIndex={0}
            aria-label="Document"
            onPointerDown={() => { selectionClick.current = false; }}
            onMouseUp={onMouseUp}
            onKeyUp={(event) => { if (event.key === 'Shift') onMouseUp(); }}
            onKeyDown={(event) => {
              moveDocumentSelection(event);
              const id = (event.target as HTMLElement).closest('[data-thread-id]')?.getAttribute('data-thread-id');
              if (id && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); focusDiscussion(id); }
            }}
            onClick={onDocClick}
          >
            <div className="doc-body" ref={bodyRef}>
              {htmlSource ? (
                <div
                  className="doc-frame-shell"
                  ref={htmlFrameShellRef}
                  style={htmlFrameHeight ? { height: `${htmlFrameHeight * htmlFrameScale}px` } : undefined}
                >
                  <iframe
                    ref={htmlFrameRef}
                    className="doc-frame"
                    title="Rendered HTML document"
                    srcDoc={htmlFrameSrcDoc}
                    style={{ height: `${htmlFrameHeight}px` }}
                    onLoad={() => {
                      syncHtmlFrameHeight();
                      syncHtmlFrameScale();
                      setHtmlFrameLoadCount((count) => count + 1);
                    }}
                  />
                </div>
              ) : (
                <div dangerouslySetInnerHTML={{ __html: docHtml }} />
              )}
            </div>
            {compose && composerHost && createPortal(
              <div
                className="floating review-composer"
                data-docthread-ui
                onClick={(e) => e.stopPropagation()}
                onMouseUp={(e) => e.stopPropagation()}
                role="region"
                aria-label="New comment"
              >
                <p className="compose-quote">{compose.anchor.quote}</p>
                <MentionEditor
                  className="compose-textarea"
                  placeholder="Comment on the selected text..."
                  value={composeText}
                  mentions={composeMentions}
                  localCandidates={mentionOptions}
                  providerLabel={sourceTarget?.kind === 'github' ? 'repository collaborators' : 'your organization directory'}
                  search={searchIdentities}
                  onRequestSignIn={requestIdentitySignIn}
                  onChange={(value, mentions) => { setComposeText(value); setComposeMentions(mentions); }}
                />
                <fieldset className="compose-intent" aria-label="Comment type">
                  {THREAD_INTENTS.map((intent) => (
                    <label key={intent.value}>
                      <input type="radio" name="compose-intent" value={intent.value} checked={composeIntent === intent.value} onChange={() => setComposeIntent(intent.value)} />
                      <span>{intent.label}</span>
                    </label>
                  ))}
                </fieldset>
                <label className="suggest-edit-option"><input type="checkbox" checked={composeSuggest} onChange={(event) => setComposeSuggest(event.target.checked)} /> Suggest an edit</label>
                {composeSuggest && (
                  <div className="compose-suggestion">
                    <div className="suggest-before" title="The selected text to replace">
                      <span className="suggest-label">Replace</span>
                      <code>{compose.anchor.quote}</code>
                    </div>
                    <textarea
                      className="compose-textarea suggest-replacement"
                      placeholder="Proposed replacement…"
                      value={composeReplacement}
                      onChange={(event) => setComposeReplacement(event.target.value)}
                      aria-label="Proposed replacement text"
                    />
                  </div>
                )}
                <div className="compose-hint">
                  {!sourceTarget || !canPublishReview ? 'Feedback stays in this browser.' : ''}
                </div>
                <div className="compose-actions">
                  <button
                    className="primary"
                    onClick={submitCompose}
                    disabled={!composeText.trim() && !(composeSuggest && composeReplacement !== compose.anchor.quote)}
                  >
                    {composeSuggest ? 'Post suggestion' : 'Post comment'}
                  </button>
                  <button
                    onClick={() => {
                      if ((composeText.trim() || (composeSuggest && composeReplacement !== compose.anchor.quote)) && !window.confirm('Discard this unsent comment?')) return;
                      setCompose(null);
                      setComposeText('');
                      setComposeMentions([]);
                      setComposeSuggest(false);
                      docRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>,
              composerHost
            )}
          </div>
        )}

        <CommentGutter
          key={docPath}
          threadFocusRequest={threadFocusRequest}
          onThreadFocused={() => setThreadFocusRequest(null)}
          toolsHost={toolsHost}
          controlsHost={reviewControlsHost}
          composerHostRef={setComposerHost}
          documentRoot={!editing && !sourceLoading ? bodyRef.current : null}
          draftAnchor={compose?.anchor ?? null}
          onFocusThread={focusDiscussion}
          commentHint={!editing && !commentHintDismissed && canComment ? (
            <div className="comment-hint">
              <span>Select a passage to comment.</span>
              <button type="button" aria-label="Dismiss commenting hint" onClick={() => setCommentHintDismissed(true)}>Close</button>
            </div>
          ) : null}
          threads={visibleThreads}
          activeId={activeId}
          viewerNames={[commentAuthor]}
          viewerIdentityKeys={reactionViewerKeys}
          canComment={canComment && !sourceLoading}
          canMutateShared={canMutateShared && !sourceLoading}
          canCaptureReviewInsights={Boolean(sourceTarget && sourceAccessConfigured(sourceTarget) &&
            canPublishReview && canComment && !sourceLoading &&
            (sourceTarget.kind === 'ado-workitem' || commentAuthorIdentityKeys.length > 0))}
          reviewSessionContext={JSON.stringify([docPath, ghUser?.nodeId, ghUser?.login,
            azureUser?.tenantId, azureUser?.objectId, azureUser?.login])}
          replyDrafts={replyDrafts}
          onReplyDraftChange={(id, draft) => setReplyDrafts(previous => ({ ...previous, [id]: draft }))}
          docTitle={
            sourceTitleText ||
            (sourceTarget ? sourceDocumentLabel(sourceTarget) : 'Built-in sample document')
          }
          summarizeEndpoint={SUMMARIZE_ENDPOINT}
          markdown={reviewDocumentText}
          readinessEndpoint={READINESS_ENDPOINT}
          onPromoteGap={promoteReadinessGap}
          onLocateGap={locateReadinessGap}
          reviewEndpoint={REVIEW_ENDPOINT}
          loadReviewPolicy={loadReviewPolicy}
          loadSkillSource={loadSkillSource}
          onAcceptFinding={acceptReviewFinding}
          onLocateFinding={locateFinding}
          mentionCandidates={mentionOptions}
          identityProviderLabel={
            sourceTarget?.kind === 'github'
              ? 'repository collaborators'
              : 'your organization directory'
          }
          searchIdentities={searchIdentities}
          onRequestIdentitySignIn={requestIdentitySignIn}
          onReply={reply}
          onResolve={resolve}
          onDelete={del}
          onActivate={setActiveId}
          onLocateThread={(id) => { setActiveId(id); locateAnchorInDoc(threadsRef.current.find(thread => thread.id === id)?.anchor); }}
          buildThreadLink={buildThreadLink}
          canReact={canReact}
          onReact={react}
          canApplySuggestion={canApplySuggestion}
          suggestionApplyReason={suggestionApplyReason}
          onApplySuggestion={applyThreadSuggestion}
          onDismissSuggestion={dismissThreadSuggestion}
          aiSuggestEnabled={Boolean(SUGGEST_ENDPOINT)}
          aiDraftingThreadId={aiDraftingThreadId}
          onDraftAiSuggestion={draftAiSuggestion}
        />
      </div>

      {sourcePickerOpen && (
        <Dialog labelledBy="open-source-title" onClose={() => setSourcePickerOpen(false)} className="source-picker">
          <h3 id="open-source-title">Open document</h3>
          <form onSubmit={(event) => { event.preventDefault(); void connectSource(); }}>
            <label htmlFor="source-url">Document URL</label>
            <input
              id="source-url"
              className="repo-url"
              placeholder="GitHub, Azure Repos, or ADO work item URL"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
            />
            <div className="modal-actions"><button className="primary" type="submit" disabled={sourceLoading}>{sourceLoading ? 'Opening...' : 'Open'}</button></div>
          </form>
          {status && <p role="status">{status}</p>}
          <RecentsPanel
            entries={recents}
            currentKey={sourceTarget ? sourceStorageKey(sourceTarget) : null}
            collapsed={recentsCollapsed}
            onToggle={toggleRecents}
            onOpen={(entry) => { setSourceUrl(entry.url); void connectSource(entry.url); }}
          />
          <div className="modal-actions">
            <button onClick={() => loadSample()}>Open sample</button>
            <button onClick={() => setSourcePickerOpen(false)}>Cancel</button>
          </div>
        </Dialog>
      )}

      {pendingLeave && (
        <Dialog labelledBy="unsent-input-title" onClose={() => setPendingLeave(null)}>
          <h3 id="unsent-input-title">Leave with unsaved input?</h3>
          <p>{sourceTitle}</p>
          <p>{pendingLeave.reason === 'feedback' ? 'Some feedback has not been saved to the source. The local copy will be kept.' : 'Unsent comments and replies will stay with this source in this tab. Browser draft-save status is shown above.'}</p>
          <div className="modal-actions">
            <button onClick={() => setRecoveryOpen(true)}>Inspect / export</button>
            <button disabled={sourceLoading || saving || operationCount > 0} onClick={() => {
              if (sourceLoading || saving || pendingOperations.current > 0) return;
              const action = pendingLeave.run;
              setPendingLeave(null);
              action();
            }}>Keep drafts and continue</button>
            <button className="primary" onClick={() => setPendingLeave(null)}>Stay here</button>
          </div>
        </Dialog>
      )}
      {recoveryOpen && (
        <Dialog labelledBy="recovery-title" onClose={() => setRecoveryOpen(false)}>
          <h3 id="recovery-title">Unsent input</h3>
          <textarea className="recovery-text" readOnly value={recoveryText} aria-label="Recovery copy" onFocus={(event) => event.currentTarget.select()} />
          <div className="modal-actions">
            <button onClick={exportRecovery}>Download recovery copy</button>
            <button onClick={() => setRecoveryOpen(false)}>Close</button>
          </div>
        </Dialog>
      )}
      {documentRecoveryOpen && recoveredDocument?.sourceKey === docPath && (
        <Dialog labelledBy="document-recovery-title" onClose={() => setDocumentRecoveryOpen(false)}>
          <h3 id="document-recovery-title">Document draft</h3>
          <p>{sourceTitle}</p>
          <label>Current source<textarea className="recovery-text" aria-label="Current source" readOnly value={savedDraftMd} /></label>
          <label>Recovered draft<textarea className="recovery-text" aria-label="Recovered draft" readOnly value={recoveredDocument.markdown} onFocus={(event) => event.currentTarget.select()} /></label>
          <div className="modal-actions">
            <button disabled={Boolean(sourceTarget && !canWriteSource)} title={sourceTarget && !canWriteSource ? 'Source write access is required to edit this document' : undefined} onClick={() => {
              setDraftMd(recoveredDocument.markdown);
              setEditing(true);
              setRecoveredDocument(null);
              setDocumentRecoveryOpen(false);
            }}>Restore draft</button>
            <button onClick={() => {
              if (!forgetDocumentDraft(docPath, recoveredDocument.markdown)) return;
              const cached = sourceInputs.current.get(docPath);
              if (cached) { const { document: _document, ...input } = cached; sourceInputs.current.set(docPath, input); }
              setRecoveredDocument(null);
              setDocumentRecoveryOpen(false);
            }}>Discard draft</button>
            <button onClick={() => setDocumentRecoveryOpen(false)}>Close</button>
          </div>
        </Dialog>
      )}
      {adoRecoveryOpen && adoRecovery?.sourceKey === docPath && (
        <Dialog labelledBy="ado-recovery-title" onClose={() => setAdoRecoveryOpen(false)}>
          <h3 id="ado-recovery-title">Local and saved feedback</h3>
          <p>{sourceTitle}</p>
          <label>Local copy<textarea className="recovery-text" aria-label="Local feedback copy" readOnly value={reviewCopyText(adoRecovery.local)} onFocus={(event) => event.currentTarget.select()} /></label>
          <label>Saved copy<textarea className="recovery-text" aria-label="Saved feedback copy" readOnly value={reviewCopyText(adoRecovery.shared)} /></label>
          {adoRecoveryError && <p role="alert">{adoRecoveryError}</p>}
          <div className="modal-actions">
            <button onClick={recoverAdoFeedback}>Combine feedback locally</button>
            <button onClick={() => {
              if (!window.confirm('Discard local feedback that is not in the saved review?')) return;
              try {
                saveLocal(reviewFile(docPath, adoRecovery.shared.threads, sourceTarget, markdown), docPath);
                threadsRef.current = adoRecovery.shared.threads;
                setThreads(adoRecovery.shared.threads);
                setAdoRecovery(null);
                setAdoRecoveryOpen(false);
              } catch {
                setAdoRecoveryError('The local copy could not be replaced. It has been kept.');
              }
            }}>Discard local changes</button>
            <button onClick={() => setAdoRecoveryOpen(false)}>Close</button>
          </div>
        </Dialog>
      )}

      {shareOpen && (
        <ShareModal
          shareLink={shareLink}
          docLabel={shareDocLabel}
          allowedDomains={NOTIFY_ALLOWED_DOMAINS}
          onSubmit={shareForReview}
          onClose={() => setShareOpen(false)}
          participation={participation}
        />
      )}

      {requestReviewOpen && (
        <Dialog labelledBy="request-review-title" onClose={() => { if (!requestReviewBusy) setRequestReviewOpen(false); }} className="request-review-modal">
          <h3 id="request-review-title">Request review</h3>
          <p className="share-doc-label">
            <strong>{shareDocLabel}</strong>
          </p>

          <div className="request-review-channels" role="list" aria-label="Review channels">
            {requestReviewChannels.map((channel) => (
              <button
                key={channel.channel}
                type="button"
                role="listitem"
                className={requestReviewDraft.channel === channel.channel ? 'selected' : ''}
                disabled={!channel.available}
                onClick={() => updateRequestReviewDraft({ channel: channel.channel })}
              >
                <strong>{channel.label}</strong>
                <span>{channel.artifact} · {channel.provider}</span>
                {channel.available ? (
                  <small>Available for this document</small>
                ) : (
                  <small>{channel.gatedReason || channel.missing.join(' ')}</small>
                )}
              </button>
            ))}
          </div>

          {requestReviewDraft.channel === 'github-issue' && (
            <div className="request-review-form">
              <label className="share-field-label" htmlFor="request-review-title-input">Title</label>
              <input
                id="request-review-title-input"
                className="share-link-input"
                value={requestReviewDraft.title}
                onChange={(event) => updateRequestReviewDraft({ title: event.target.value })}
              />

              <div className="request-review-branches">
                <label>
                  Source ref
                  <input
                    className="share-link-input"
                    readOnly
                    value={sourceTarget && sourceTarget.kind !== 'ado-workitem' ? sourceReferenceLabel(sourceTarget) : ''}
                  />
                </label>
              </div>

              <label className="share-field-label" htmlFor="request-review-scope">Review scope</label>
              <textarea
                id="request-review-scope"
                className="share-message"
                rows={2}
                value={requestReviewDraft.scope}
                onChange={(event) => updateRequestReviewDraft({ scope: event.target.value })}
              />

              <label className="share-field-label" htmlFor="request-review-instructions">Instructions</label>
              <textarea
                id="request-review-instructions"
                className="share-message"
                rows={3}
                value={requestReviewDraft.instructions}
                onChange={(event) => updateRequestReviewDraft({ instructions: event.target.value })}
              />

              <label className="share-field-label" htmlFor="request-review-reviewers">
                GitHub reviewers
              </label>
              <textarea
                id="request-review-reviewers"
                className="share-emails"
                rows={2}
                placeholder="@octocat, docs-team-member"
                value={requestReviewDraft.reviewersText}
                onChange={(event) => updateRequestReviewDraft({ reviewersText: event.target.value })}
              />
              <p className="share-hint">
                Enter GitHub-visible user handles. Adding assignees retains existing assignees; removing a name here does not unassign anyone. GitHub's response determines confirmed assignees.
              </p>
            </div>
          )}

          {requestReviewPreview && (
            <section className="request-review-preview" aria-label="Request review preview">
              <h4>Preview</h4>
              <dl>
                <div><dt>Provider</dt><dd>{requestReviewPreview.provider}</dd></div>
                <div><dt>Repository</dt><dd>{requestReviewPreview.repository}</dd></div>
                <div><dt>Source ref</dt><dd>{requestReviewPreview.sourceBranch}</dd></div>
                <div><dt>Document path</dt><dd>{requestReviewPreview.document}</dd></div>
                <div><dt>Assignees</dt><dd>{requestReviewPreview.reviewers.map((reviewer) => `@${reviewer}`).join(', ')}</dd></div>
                <div><dt>Issue title</dt><dd>{requestReviewPreview.title}</dd></div>
                <div><dt>DocThread link</dt><dd><a href={requestReviewPreview.docThreadLink} target="_blank" rel="noreferrer">Open DocThread</a></dd></div>
                <div><dt>Source link</dt><dd><a href={requestReviewPreview.sourceLink} target="_blank" rel="noreferrer">Open source</a></dd></div>
              </dl>
              <textarea
                className="recovery-text"
                readOnly
                aria-label="GitHub issue body preview"
                value={requestReviewPreview.body}
              />
            </section>
          )}

          {requestReviewError && <p role="alert" className="share-warning">{requestReviewError}</p>}
          <div className="share-actions">
            <button type="button" onClick={() => setRequestReviewOpen(false)} disabled={requestReviewBusy}>Cancel</button>
            <button
              type="button"
              onClick={previewRequestReview}
              disabled={saving || requestReviewBusy || requestReviewDraft.channel !== 'github-issue' || !requestReviewChannels[0].available}
            >
              Preview request
            </button>
            <button
              type="button"
              className="primary"
              onClick={submitRequestReview}
              disabled={
                saving ||
                requestReviewBusy ||
                !requestReviewPreview ||
                validateGitHubRequestPreview(requestReviewPreview).length > 0 ||
                !requestReviewChannels[0].available || reviewPreviewScope.current !== currentReviewScope
              }
            >
              {requestReviewBusy
                ? 'Checking request...'
                : requestReviewPreview?.duplicate && requestReviewPreview.duplicate.status !== 'unknown'
                  ? `Add assignees${parseReviewerHandles(requestReviewDraft.reviewersText).length ? ` (${parseReviewerHandles(requestReviewDraft.reviewersText).length})` : ''}`
                  : `Create review request${parseReviewerHandles(requestReviewDraft.reviewersText).length ? ` (${parseReviewerHandles(requestReviewDraft.reviewersText).length})` : ''}`}
            </button>
          </div>
        </Dialog>
      )}

      {githubSourceChoices.length > 0 && (
        <Dialog labelledBy="source-choice-title" onClose={() => setGitHubSourceChoices([])} className="source-choice-modal">
            <h3 id="source-choice-title">Choose the exact GitHub source</h3>
            <p>The pasted URL can identify more than one verified ref and file.</p>
            <div className="source-choices">
              {githubSourceChoices.map((candidate) => (
                <button
                  type="button"
                  key={`${candidate.versionType}:${candidate.ref}:${candidate.path}`}
                  onClick={() => void connectResolvedSource(candidate)}
                >
                  <strong>{candidate.versionType}</strong>
                  <span>{candidate.ref}</span>
                  <code>{candidate.path}</code>
                  <small>{candidate.commitSha.slice(0, 12)}</small>
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button type="button" onClick={() => setGitHubSourceChoices([])}>
                Cancel
              </button>
            </div>
        </Dialog>
      )}

      {saveChoice && sourceTarget && (
        <Dialog labelledBy="save-source-title" onClose={() => { if (!saving) setSaveChoice(false); }}>
            <h3 id="save-source-title">Save your edits to {sourceProviderName(sourceTarget)}</h3>
            <p>
              You edited <code>{sourceDocumentLabel(sourceTarget)}</code> in{' '}
              <strong>
                {sourceRepositoryLabel(sourceTarget)}
              </strong>
              . How would you like to save it?
            </p>
            <div className="modal-actions">
              <button className="primary" disabled={saving} onClick={commitEdit}>
                {sourceTarget.kind === 'ado-workitem' ? (
                  <>Update <code>{sourceReferenceLabel(sourceTarget)}</code></>
                ) : (
                  <>Commit to <code>{sourceReferenceLabel(sourceTarget)}</code></>
                )}
              </button>
              {sourceSupportsPullRequest(sourceTarget) && (
                <button disabled={saving} onClick={prEdit}>
                  Create pull request
                </button>
              )}
              <button className="ghost" disabled={saving} onClick={() => setSaveChoice(false)}>
                Keep in this tab
              </button>
            </div>
            {saving && (
              <div className="modal-note">
                Working… talking to {sourceProviderName(sourceTarget)}.
              </div>
            )}
            {status && <p role="status">{status}</p>}
        </Dialog>
      )}
    </div>
  );
}

// Signature so thread changes repaint without depending on paint-synced fields.
function paintSignature(threads: Thread[]): string {
  return threads
    .map((t) => `${t.id}:${t.comments.length}:${t.resolved ? 1 : 0}:${t.anchor.quote.length}`)
    .join('|');
}

// ---------------------------------------------------------------------------
// Shared Markdown renderer (#38). Read mode renders this to a static HTML string
// (docHtml) for the highlight backdrop; the Edit-mode live preview renders the
// same component, so the preview output matches the final document exactly.
// ---------------------------------------------------------------------------
function MarkdownDoc({ text }: { text: string }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>;
}

// ---------------------------------------------------------------------------
// Edit view with live highlights: a transparent <textarea> layered over a
// "backdrop" that paints <mark>s where review comments are anchored, so the
// author can see exactly what needs editing while they type.
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildEditHighlightHTML(text: string, threads: Thread[], activeId: string | null): string {
  const ranges: InputRange[] = [];
  for (const t of threads) {
    const loc = locateInText(text, t.anchor);
    if (!loc || loc.end <= loc.start) continue;
    const cls = ['edit-hl'];
    if (t.resolved) cls.push('resolved');
    if (loc.confidence === 'needs-confirmation') cls.push('unsure');
    else if (loc.confidence === 'medium') cls.push('fuzzy');
    if (t.id === activeId) cls.push('active');
    ranges.push({ start: loc.start, end: loc.end, id: t.id, classes: cls });
  }

  let out = '';
  let pos = 0;
  for (const flat of flattenRanges(ranges, text.length)) {
    if (flat.start > pos) out += escapeHtml(text.slice(pos, flat.start));
    out += `<mark class="${flat.classes.join(' ')}">${escapeHtml(
      text.slice(flat.start, flat.end)
    )}</mark>`;
    pos = flat.end;
  }
  out += escapeHtml(text.slice(pos));
  // A trailing newline needs an extra char or the backdrop's last line collapses.
  if (text.endsWith('\n')) out += ' ';
  return out;
}

function HighlightedEditor({
  value,
  onChange,
  threads,
  activeId,
  format,
  spellCheck,
  onScrollRatio,
}: {
  value: string;
  onChange: (v: string) => void;
  threads: Thread[];
  activeId: string | null;
  format: DocumentFormat;
  spellCheck: boolean;
  onScrollRatio?: (ratio: number) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const backRef = useRef<HTMLDivElement>(null);
  const pendingSel = useRef<[number, number] | null>(null);
  const html = useMemo(
    () => (format === 'html' ? escapeHtmlText(value) : buildEditHighlightHTML(value, threads, activeId)),
    [value, threads, activeId, format]
  );
  const syncScroll = () => {
    if (backRef.current && taRef.current) {
      backRef.current.scrollTop = taRef.current.scrollTop;
      backRef.current.scrollLeft = taRef.current.scrollLeft;
    }
    if (onScrollRatio && taRef.current) {
      const ta = taRef.current;
      const denom = ta.scrollHeight - ta.clientHeight;
      onScrollRatio(denom > 0 ? ta.scrollTop / denom : 0);
    }
  };

  // Apply a toolbar formatting command to the current selection, writing the
  // result back through the normal draft onChange path and remembering the new
  // selection so it can be restored after React re-renders the textarea.
  const runCommand = useCallback(
    (command: ToolbarCommand) => {
      if (format === 'html') return;
      const ta = taRef.current;
      if (!ta) return;
      const next = applyCommand(command, {
        text: value,
        start: ta.selectionStart,
        end: ta.selectionEnd,
      });
      if (next.text === value) {
        // Selection-only change (e.g. re-toggle no-op) — still restore focus.
        ta.focus();
        return;
      }
      pendingSel.current = [next.start, next.end];
      onChange(next.text);
    },
    [value, onChange, format]
  );

  // Restore the caret/selection after a toolbar command mutates the value.
  useLayoutEffect(() => {
    if (!pendingSel.current) return;
    const ta = taRef.current;
    const [s, e] = pendingSel.current;
    pendingSel.current = null;
    if (!ta) return;
    ta.focus();
    try {
      ta.setSelectionRange(s, e);
    } catch {
      /* ignore selection failures */
    }
    syncScroll();
  }, [value]);

  // When a discussion is selected, jump the editor to that line and select the text.
  useEffect(() => {
    if (!activeId || format === 'html') return;
    const t = threads.find((x) => x.id === activeId);
    const ta = taRef.current;
    if (!t || !ta) return;
    const loc = locateInText(value, t.anchor);
    if (!loc) return;
    const line = value.slice(0, loc.start).split('\n').length - 1;
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 21;
    ta.scrollTop = Math.max(0, line * lineHeight - ta.clientHeight / 2);
    syncScroll();
    try {
      ta.focus();
      ta.setSelectionRange(loc.start, loc.end);
    } catch {
      /* ignore selection failures */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (format === 'html') return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = e.key.toLowerCase();
    const map: Record<string, ToolbarCommand> = { b: 'bold', i: 'italic', k: 'link' };
    const command = map[key];
    if (!command) return;
    e.preventDefault();
    runCommand(command);
  };

  return (
    <div className="editor-shell">
      {format === 'markdown' && <MarkdownToolbar onCommand={runCommand} />}
      <div className="editor-wrap">
        <div
          className="editor-backdrop"
          ref={backRef}
          aria-hidden
          dangerouslySetInnerHTML={{ __html: html }}
        />
        <textarea
          className="editor-input"
          aria-label="Document draft"
          ref={taRef}
          value={value}
          spellCheck={spellCheck}
          onChange={(e) => onChange(e.target.value)}
          onScroll={syncScroll}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}

const TOOLBAR_BUTTONS: {
  command: ToolbarCommand;
  label: string;
  title: string;
}[] = [
  { command: 'heading', label: 'H', title: 'Heading' },
  { command: 'bold', label: 'B', title: 'Bold (Ctrl/⌘+B)' },
  { command: 'italic', label: 'I', title: 'Italic (Ctrl/⌘+I)' },
  { command: 'quote', label: '❝', title: 'Quote' },
  { command: 'code', label: '</>', title: 'Code' },
  { command: 'link', label: '🔗', title: 'Link (Ctrl/⌘+K)' },
  { command: 'ordered-list', label: '1.', title: 'Numbered list' },
  { command: 'unordered-list', label: '•', title: 'Bulleted list' },
  { command: 'task-list', label: '☑', title: 'Task list' },
];

// Formatting toolbar (#78): lets non-technical authors apply common Markdown
// without knowing the syntax. Each button transforms the current selection in
// the editor via markdownToolbar.applyCommand; the source stays raw Markdown.
function MarkdownToolbar({ onCommand }: { onCommand: (c: ToolbarCommand) => void }) {
  return (
    <div className="md-toolbar" role="toolbar" aria-label="Formatting" data-docthread-ui>
      {TOOLBAR_BUTTONS.map((b) => (
        <button
          key={b.command}
          type="button"
          className="md-toolbar-btn"
          title={b.title}
          aria-label={b.title}
          // Keep the textarea selection while clicking the button.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onCommand(b.command)}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
