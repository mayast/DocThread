import React from 'react';
import ReactMarkdown from 'react-markdown';
import { renderToStaticMarkup } from 'react-dom/server';
import remarkGfm from 'remark-gfm';
import TurndownService from 'turndown';

import type { AdoWorkItemTarget } from './source.ts';
import type { DocThreadFileV1 } from './types.ts';
import { ProviderError, requireProviderJson } from './providerError.ts';

const API_VERSION = '7.1';
const COMMENTS_API_VERSION = '7.1-preview.4';

/**
 * Where an ADO work item's DocThread review (threads + doc snapshot) is stored.
 * Replaces the shared `gim-home/DocThread/.docthread-reviews/ado/` git store so
 * the review lives with the work item and inherits its access control.
 *   • attachment  — a JSON file attached to the work item (default; cleanest).
 *   • description — a hidden marker block appended to System.Description.
 *   • discussion  — a marker comment in the work item's Discussion.
 */
export type AdoReviewStoreMode = 'attachment' | 'discussion';

export const ADO_REVIEW_STORE_MODES: AdoReviewStoreMode[] = [
  'attachment',
  'discussion',
];

const REVIEW_ATTACHMENT_NAME = 'docthread-review.json';
// The review JSON is base64-wrapped inside an HTML comment so it stays hidden in
// the rendered description / discussion and survives HTML round-trips.
const REVIEW_MARKER = 'docthread-review:v1';
// Azure DevOps rich-text fields (System.Description and work-item comments) run an HTML
// sanitizer that strips comment nodes (`<!-- ... -->`) but preserves a `display:none` <div>.
// So the payload is carried inside a hidden <div>; extraction just locates the marker token
// plus its base64 wherever it survives (tolerant of ADO's HTML normalization / added spaces).
const REVIEW_MARKER_RE = /docthread-review:v1\s+([A-Za-z0-9+/=]+)/;
// Strips the hidden marker wrapper (current hidden-div form + legacy HTML-comment form).
const REVIEW_MARKER_STRIP_RE =
  /(?:<div[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>\s*docthread-review:v1[\s\S]*?<\/div>|<!--\s*docthread-review:v1\s+[A-Za-z0-9+/=]+\s*-->)/gi;

function encodeReview(file: DocThreadFileV1): string {
  const json = JSON.stringify(file);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeAdoReviewSnapshot(json: string): DocThreadFileV1 | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.threads)) {
      return parsed as DocThreadFileV1;
    }
  } catch {
    /* corrupt or foreign payload — treat as no stored review */
  }
  return null;
}

function decodeReview(base64: string): DocThreadFileV1 | null {
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return decodeAdoReviewSnapshot(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function reviewMarkerBlock(file: DocThreadFileV1): string {
  return `<div style="display:none">${REVIEW_MARKER} ${encodeReview(file)}</div>`;
}

function extractReviewFromHtml(html: string): DocThreadFileV1 | null {
  const match = html.match(REVIEW_MARKER_RE);
  return match ? decodeReview(match[1]) : null;
}

function stripReviewMarker(html: string): string {
  return html.replace(REVIEW_MARKER_STRIP_RE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const INTENT_LABELS: Record<string, string> = {
  question: 'Question',
  suggestion: 'Suggestion',
  blocking: 'Blocking',
};

// Render the review as a human-readable Azure DevOps discussion comment: for each
// active thread show the anchored text ("which line") and every comment, so the
// discussion is meaningful to read in ADO. The exact machine payload is still
// appended as a hidden marker so DocThread can round-trip it losslessly.
function discussionCommentHtml(file: DocThreadFileV1): string {
  const threads = (file.threads || []).filter((thread) => !thread.deletedAt);
  const count = threads.length;
  const header =
    `<p><strong>DocThread review</strong> — ${count} comment thread${count === 1 ? '' : 's'}. ` +
    `Managed by DocThread; the data block below is used to sync and should not be edited.</p>`;
  const blocks = threads.map((thread) => {
    const intent = INTENT_LABELS[thread.intent || 'question'] || 'Question';
    const state = thread.resolved ? ' · Resolved' : '';
    const quote = escapeHtml((thread.anchor?.quote || '').trim()).slice(0, 400);
    const anchorLine = quote
      ? `<p style="margin:0 0 4px 0"><strong>${intent}${state}</strong> — on &ldquo;<em>${quote}</em>&rdquo;</p>`
      : `<p style="margin:0 0 4px 0"><strong>${intent}${state}</strong></p>`;
    const comments = (thread.comments || [])
      .map(
        (comment) =>
          `<p style="margin:0 0 2px 0">${escapeHtml(comment.author || 'Unknown')}: ${escapeHtml(
            comment.body || ''
          )}</p>`
      )
      .join('');
    return `<div style="margin:0 0 10px 0">${anchorLine}${comments}</div>`;
  });
  const body = count > 0 ? blocks.join('') : '<p><em>No open review comments.</em></p>';
  return `${header}${body}${reviewMarkerBlock(file)}`;
}



export interface AdoWorkItem {
  id: number;
  revision: number;
  title: string;
  descriptionHtml: string;
  type?: string;
  state?: string;
  project?: string;
  url: string;
}

export interface AdoWorkItemDocument {
  text: string;
  revision: string;
  title: string;
}

export interface AdoWorkItemClientOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  getAccessToken?: (interactive: boolean) => Promise<string>;
  getHeaders?: () => Record<string, string>;
}

export class AdoWorkItemError extends ProviderError {}

let turndownService: TurndownService | null = null;

function turndown(): TurndownService {
  if (turndownService) return turndownService;
  const service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  });
  service.addRule('divAsBlock', {
    filter: ['div'],
    replacement: (content) => (content.trim() ? `\n\n${content}\n\n` : '\n'),
  });
  turndownService = service;
  return service;
}

export function htmlToMarkdown(html: string): string {
  const value = html.trim();
  if (!value) return '';
  try {
    return turndown().turndown(value).trim();
  } catch {
    return value
      .replace(/<br\s*\/?>(\n)?/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6])>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

export const EMPTY_DESCRIPTION = '_(This work item has no description.)_';

export function workItemUrl(target: AdoWorkItemTarget): string {
  const project = target.project ? `${encodeURIComponent(target.project)}/` : '';
  return `https://dev.azure.com/${encodeURIComponent(
    target.organization
  )}/${project}_workitems/edit/${target.id}`;
}

export function workItemToMarkdown(workItem: AdoWorkItem): string {
  const metadata = [
    workItem.type,
    workItem.state ? `_${workItem.state}_` : undefined,
    `#${workItem.id}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const body = htmlToMarkdown(stripReviewMarker(workItem.descriptionHtml)) || EMPTY_DESCRIPTION;
  return `# ${workItem.title}\n\n${metadata}\n\n---\n\n${body}\n`;
}

export function splitDocForAdo(markdown: string): { title?: string; body: string } {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.find((line) => /^#\s+/.test(line));
  const title = heading?.replace(/^#\s+/, '').trim() || undefined;
  const separator = lines.findIndex((line) => line.trim() === '---');
  const rawBody = (separator >= 0 ? lines.slice(separator + 1).join('\n') : markdown).trim();
  return { title, body: rawBody === EMPTY_DESCRIPTION ? '' : rawBody };
}

export function markdownBodyToHtml(markdown: string): string {
  if (!markdown.trim()) return '';
  return renderToStaticMarkup(
    React.createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, markdown)
  );
}

function workItemApiPath(target: AdoWorkItemTarget): string {
  const project = target.project ? `/${encodeURIComponent(target.project)}` : '';
  return `/${encodeURIComponent(target.organization)}${project}/_apis/wit/workitems/${target.id}`;
}

function normalizeWorkItem(target: AdoWorkItemTarget, payload: any): AdoWorkItem {
  const fields = payload.fields || {};
  return {
    id: payload.id ?? target.id,
    revision: payload.rev ?? 0,
    title: fields['System.Title'] || `Work item ${target.id}`,
    descriptionHtml: fields['System.Description'] || '',
    type: fields['System.WorkItemType'],
    state: fields['System.State'],
    project: fields['System.TeamProject'],
    url: workItemUrl(target),
  };
}

export function createAdoWorkItemClient(options: AdoWorkItemClientOptions = {}) {
  const baseUrl = (options.baseUrl || 'https://dev.azure.com').replace(/\/+$/, '');
  const fetchImpl = options.fetch || fetch;
  const getAccessToken = options.getAccessToken || (async () => '');
  const getHeaders: () => Record<string, string> = options.getHeaders || (() => ({}));

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method || 'GET').toUpperCase();
    let token = await getAccessToken(method !== 'GET');
    let prompted = false;

    while (true) {
      const headers = new Headers(init.headers);
      const extraHeaders = getHeaders();
      for (const name of Object.keys(extraHeaders)) headers.set(name, extraHeaders[name]);
      headers.set('Accept', 'application/json');
      if (token) headers.set('Authorization', `Bearer ${token}`);
      const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers });
      if (response.status === 401 && !prompted && !token) {
        prompted = true;
        token = await getAccessToken(true);
        if (token) continue;
      }
      try {
        return await requireProviderJson(response, {
          provider: 'Azure DevOps work items',
          tokenSent: Boolean(token),
        });
      } catch (error) {
        if (error instanceof ProviderError) {
          throw new AdoWorkItemError(error.kind, error.message, error.status);
        }
        throw error;
      }
    }
  }

  async function fetchWorkItem(target: AdoWorkItemTarget): Promise<AdoWorkItem> {
    const query = new URLSearchParams({
      'api-version': API_VERSION,
      fields: 'System.Title,System.Description,System.WorkItemType,System.State,System.TeamProject',
    });
    const response = await request(`${workItemApiPath(target)}?${query}`);
    return normalizeWorkItem(target, await response.json());
  }

  // Like `request`, but returns the raw Response (no ADO-envelope JSON coercion)
  // so attachment content and empty bodies can be read directly.
  async function rawRequest(path: string, init: RequestInit = {}): Promise<Response> {
    const method = (init.method || 'GET').toUpperCase();
    const token = await getAccessToken(method !== 'GET');
    const headers = new Headers(init.headers);
    const extraHeaders = getHeaders();
    for (const name of Object.keys(extraHeaders)) headers.set(name, extraHeaders[name]);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const response = await fetchImpl(`${baseUrl}${path}`, { ...init, headers });
    if (!response.ok || response.headers.get('content-type')?.includes('text/html')) {
      await requireProviderJson(response, { provider: 'Azure DevOps review', tokenSent: Boolean(token) });
    }
    return response;
  }

  function orgProjectPath(target: AdoWorkItemTarget): string {
    const project = target.project ? `/${encodeURIComponent(target.project)}` : '';
    return `/${encodeURIComponent(target.organization)}${project}`;
  }

  // Convert an absolute dev.azure.com attachment URL into a proxy-relative path
  // so it flows through the same (possibly dev-proxied) base URL and auth.
  function toRelativeAdoPath(absoluteUrl: string): string | null {
    try {
      const url = new URL(absoluteUrl);
      return `${url.pathname}${url.search}`;
    } catch {
      return null;
    }
  }

  async function fetchWorkItemRelations(target: AdoWorkItemTarget): Promise<any[]> {
    const query = new URLSearchParams({ 'api-version': API_VERSION, '$expand': 'relations' });
    const response = await request(`${workItemApiPath(target)}?${query}`);
    const payload = await response.json();
    return Array.isArray(payload.relations) ? payload.relations : [];
  }

  function isReviewAttachment(relation: any): boolean {
    return (
      relation?.rel === 'AttachedFile' &&
      (relation?.attributes?.name === REVIEW_ATTACHMENT_NAME ||
        String(relation?.attributes?.comment || '').startsWith('docthread-review'))
    );
  }

  // ---- attachment mode ----
  async function readAttachmentReview(target: AdoWorkItemTarget): Promise<DocThreadFileV1 | null> {
    const relations = await fetchWorkItemRelations(target);
    const reviewRelations = relations.filter(isReviewAttachment);
    if (reviewRelations.length === 0) return null;
    // Newest wins: the latest linked attachment is the current review.
    const newest = reviewRelations[reviewRelations.length - 1];
    const path = toRelativeAdoPath(newest.url);
    if (!path) throw new AdoWorkItemError('transport', 'The saved review attachment has an invalid URL.', 502);
    const separator = path.includes('?') ? '&' : '?';
    const response = await rawRequest(`${path}${separator}download=true`);
    const review = decodeReview(btoa(unescape(encodeURIComponent(await response.text()))));
    if (!review) throw new AdoWorkItemError('transport', 'The saved review attachment could not be decoded.', 502);
    return review;
  }

  async function saveAttachmentReview(
    target: AdoWorkItemTarget,
    file: DocThreadFileV1
  ): Promise<void> {
    const json = JSON.stringify(file, null, 2);
    const uploadQuery = new URLSearchParams({
      fileName: REVIEW_ATTACHMENT_NAME,
      'api-version': API_VERSION,
    });
    const uploadResponse = await request(
      `${orgProjectPath(target)}/_apis/wit/attachments?${uploadQuery}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json }
    );
    const attachment = await uploadResponse.json();
    if (!attachment?.url) throw new AdoWorkItemError('transport', 'Attachment upload returned no URL.', 502);

    const relations = await fetchWorkItemRelations(target);
    const operations: Array<Record<string, unknown>> = [];
    // Remove prior review attachments (descending index) before adding the new one.
    relations.forEach((relation, index) => {
      if (isReviewAttachment(relation)) operations.push({ op: 'remove', path: `/relations/${index}`, index });
    });
    operations
      .sort((a, b) => (b.index as number) - (a.index as number))
      .forEach((op) => delete op.index);
    operations.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'AttachedFile',
        url: attachment.url,
        attributes: { name: REVIEW_ATTACHMENT_NAME, comment: 'docthread-review' },
      },
    });
    const query = new URLSearchParams({ 'api-version': API_VERSION });
    await request(`${workItemApiPath(target)}?${query}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify(operations),
    });
  }

  // ---- discussion mode ----
  async function findDiscussionReviewComment(
    target: AdoWorkItemTarget
  ): Promise<{ id: number; review: DocThreadFileV1 | null } | null> {
    const query = new URLSearchParams({ 'api-version': COMMENTS_API_VERSION, order: 'desc' });
    const response = await rawRequest(
      `${orgProjectPath(target)}/_apis/wit/workItems/${target.id}/comments?${query}`
    );
    const payload = await response.json();
    const comments: any[] = Array.isArray(payload?.comments) ? payload.comments : [];
    for (const comment of comments) {
      const text = String(comment?.text || '');
      if (REVIEW_MARKER_RE.test(text) && comment?.id != null) {
        const review = extractReviewFromHtml(text);
        if (!review) throw new AdoWorkItemError('transport', 'The saved discussion review could not be decoded.', 502);
        return { id: Number(comment.id), review };
      }
    }
    return null;
  }

  async function readDiscussionReview(target: AdoWorkItemTarget): Promise<DocThreadFileV1 | null> {
    const existing = await findDiscussionReviewComment(target);
    return existing?.review ?? null;
  }

  async function saveDiscussionReview(
    target: AdoWorkItemTarget,
    file: DocThreadFileV1
  ): Promise<void> {
    const text = discussionCommentHtml(file);
    const existing = await findDiscussionReviewComment(target);
    const basePath = `${orgProjectPath(target)}/_apis/wit/workItems/${target.id}/comments`;
    if (existing) {
      // Update the single DocThread-managed comment in place so the discussion is
      // not spammed with a new comment on every auto-save.
      const query = new URLSearchParams({ 'api-version': COMMENTS_API_VERSION });
      await rawRequest(`${basePath}/${existing.id}?${query}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      return;
    }
    const query = new URLSearchParams({ 'api-version': COMMENTS_API_VERSION });
    await rawRequest(`${basePath}?${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  }

  return {
    async resolveTarget(target: AdoWorkItemTarget): Promise<AdoWorkItemTarget> {
      const workItem = await fetchWorkItem({ ...target, project: undefined });
      if (!workItem.project) {
        throw new Error('Azure DevOps did not return System.TeamProject for this work item.');
      }
      return { ...target, project: workItem.project };
    },

    async fetchDocument(target: AdoWorkItemTarget): Promise<AdoWorkItemDocument> {
      const workItem = await fetchWorkItem(target);
      return {
        text: workItemToMarkdown(workItem),
        revision: String(workItem.revision),
        title: workItem.title,
      };
    },

    async updateDocument(
      target: AdoWorkItemTarget,
      markdown: string,
      _revision: string | null
    ): Promise<AdoWorkItemDocument> {
      const { title, body } = splitDocForAdo(markdown);
      const newBodyHtml = markdownBodyToHtml(body);

      // Reconcile against the latest work item on every save. This does two
      // things: (1) it reads the current /rev so our own review-saves — which can
      // mutate the work item and bump /rev without the app noticing — don't
      // trigger a phantom "Test Operation for path /rev failed" (VS403351)
      // conflict that leaves the save dialog stuck; and (2) it preserves any
      // hidden review marker still present in the description (e.g. a legacy
      // description-mode review) so editing the doc body never drops it.
      const attempt = async (): Promise<Response> => {
        const current = await fetchWorkItem(target);
        const marker = extractReviewFromHtml(current.descriptionHtml || '');
        const descriptionValue = marker
          ? `${newBodyHtml}\n${reviewMarkerBlock(marker)}`
          : newBodyHtml;
        const operations: Array<{ op: string; path: string; value: string | number }> = [];
        if (Number.isInteger(current.revision) && current.revision > 0) {
          operations.push({ op: 'test', path: '/rev', value: current.revision });
        }
        if (title) operations.push({ op: 'add', path: '/fields/System.Title', value: title });
        operations.push({ op: 'add', path: '/fields/System.Description', value: descriptionValue });

        const query = new URLSearchParams({ 'api-version': API_VERSION });
        return request(`${workItemApiPath(target)}?${query}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json-patch+json' },
          body: JSON.stringify(operations),
        });
      };

      let response: Response;
      try {
        response = await attempt();
      } catch (error) {
        // Something bumped /rev between our read and write — reconcile once more.
        if (
          error instanceof AdoWorkItemError &&
          (error.status === 409 || error.status === 412)
        ) {
          response = await attempt();
        } else {
          throw error;
        }
      }

      const workItem = normalizeWorkItem(target, await response.json());
      return {
        text: workItemToMarkdown(workItem),
        revision: String(workItem.revision),
        title: workItem.title,
      };
    },

    async readReview(
      target: AdoWorkItemTarget,
      mode: AdoReviewStoreMode
    ): Promise<DocThreadFileV1 | null> {
      if (mode === 'attachment') return readAttachmentReview(target);
      return readDiscussionReview(target);
    },

    async saveReview(
      target: AdoWorkItemTarget,
      mode: AdoReviewStoreMode,
      file: DocThreadFileV1
    ): Promise<void> {
      if (mode === 'attachment') return saveAttachmentReview(target, file);
      return saveDiscussionReview(target, file);
    },

    fetchWorkItem,
  };
}
