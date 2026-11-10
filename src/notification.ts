import type {
  Comment,
  DocThreadFileV2,
  MentionReference,
  NotificationDispatch,
} from './types.ts';

export class NotificationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotificationStateError';
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

export function immutableCommentCore(comment: Comment): unknown {
  return {
    id: comment.id,
    author: comment.author,
    authorLogin: comment.authorLogin ?? null,
    authorIdentityKeys: [...(comment.authorIdentityKeys || [])].sort(),
    identityVersion: comment.identityVersion ?? null,
    localOnly: comment.localOnly ?? null,
    body: comment.body,
    createdAt: comment.createdAt,
    mentions: comment.mentions ?? null,
  };
}

export function assertImmutableCommentAccepted(expected: Comment, accepted: Comment): void {
  if (canonical(immutableCommentCore(expected)) !== canonical(immutableCommentCore(accepted))) {
    throw new NotificationStateError(
      `Persisted comment ${expected.id} does not match the immutable submitted comment.`
    );
  }
}

export function pendingGitHubDispatch(
  mentions: readonly MentionReference[]
): NotificationDispatch | undefined {
  const recipientKeys = [
    ...new Set(
      mentions.flatMap((mention) =>
        mention.kind === 'resolved' && mention.route.kind === 'github'
          ? [mention.subjectKey]
          : []
      )
    ),
  ].sort();
  return recipientKeys.length > 0
    ? { channel: 'github', state: 'pending', recipientKeys }
    : undefined;
}

export function findComment(file: DocThreadFileV2, commentId: string): Comment {
  for (const thread of file.threads) {
    const comment = thread.comments.find((candidate) => candidate.id === commentId);
    if (comment) return comment;
  }
  throw new NotificationStateError(`Comment ${commentId} was not found in accepted review state.`);
}

function assertTransition(current: NotificationDispatch, next: NotificationDispatch): void {
  if (current.channel !== next.channel || canonical(current.recipientKeys) !== canonical(next.recipientKeys)) {
    throw new NotificationStateError('Notification channel or recipient set changed during dispatch.');
  }
  if (current.state === 'pending' && next.state === 'attempted') {
    if (!next.attemptId || !next.attemptedAt) {
      throw new NotificationStateError('Attempted notification requires a durable claim identity.');
    }
    return;
  }
  if (
    current.state === 'attempted' &&
    (next.state === 'delivered' || next.state === 'failed' || next.state === 'uncertain')
  ) {
    if (current.attemptId !== next.attemptId || current.attemptedAt !== next.attemptedAt) {
      throw new NotificationStateError('Terminal notification state must preserve the attempt claim.');
    }
    return;
  }
  throw new NotificationStateError(
    `Invalid notification transition ${current.state} -> ${next.state}.`
  );
}

export function transitionCommentDispatch(
  file: DocThreadFileV2,
  commentId: string,
  next: NotificationDispatch,
  updatedAt: string
): DocThreadFileV2 {
  let found = false;
  const threads = file.threads.map((thread) => ({
    ...thread,
    comments: thread.comments.map((comment) => {
      if (comment.id !== commentId) return comment;
      found = true;
      if (!comment.dispatch) {
        throw new NotificationStateError(`Comment ${commentId} has no notification dispatch.`);
      }
      assertTransition(comment.dispatch, next);
      return { ...comment, dispatch: next };
    }),
  }));
  if (!found) throw new NotificationStateError(`Comment ${commentId} was not found.`);
  return { ...file, threads, updatedAt };
}
