import type { DocThreadFile, MentionReference } from './types.ts';
import type { SourceTarget } from './source.ts';

export function captureReviewOperation(
  source: SourceTarget | null,
  sourceKey: string,
  file: DocThreadFile,
  revision: string | null,
  version: number
) {
  return { source: structuredClone(source), sourceKey, file: structuredClone(file), revision, version };
}

export function isCurrentReviewOperation(operation: { sourceKey: string; version: number }, sourceKey: string, version: number): boolean {
  return operation.sourceKey === sourceKey && operation.version === version;
}

export interface ReplyDraft {
  body: string;
  mentions: MentionReference[];
}

export interface FeedbackNotice {
  sourceKey: string;
  version: number;
  phase: 'loaded' | 'local' | 'pending' | 'saving' | 'saved' | 'failed';
  error?: string;
}

export function acceptFeedbackOutcome(current: FeedbackNotice, outcome: FeedbackNotice): FeedbackNotice {
  if (current.sourceKey !== outcome.sourceKey || outcome.version < current.version) return current;
  return outcome;
}

export function feedbackMessage(notice: FeedbackNotice, provider: string): string {
  switch (notice.phase) {
    case 'loaded': return 'Feedback loaded';
    case 'local': return 'Feedback in this browser';
    case 'pending': return 'Feedback waiting to save';
    case 'saving': return 'Saving feedback...';
    case 'saved': return `Feedback saved to ${provider}`;
    case 'failed': return `Feedback save failed${notice.error ? `: ${notice.error}` : ''}`;
  }
}

export function hasUnsentInput(input: {
  comment: string;
  replacementChanged: boolean;
  documentChanged: boolean;
  replies: readonly ReplyDraft[];
}): boolean {
  return Boolean(input.comment.trim() || input.replacementChanged || input.documentChanged || input.replies.some(reply => reply.body.trim()));
}

export function leaveSourceReason(busy: boolean, drafts: boolean, feedback: FeedbackNotice): 'busy' | 'draft' | 'feedback' | null {
  if (busy || feedback.phase === 'saving') return 'busy';
  if (drafts) return 'draft';
  if (feedback.phase === 'pending' || feedback.phase === 'failed') return 'feedback';
  return null;
}
