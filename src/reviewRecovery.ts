import { decodeDocThreadFile } from './reviewSchema.ts';
import { mergeReviewThreads } from './reviewPersistence.ts';
import { decodeAdoReviewSnapshot } from './ado.ts';
import type { DocThreadFile, DocThreadFileV1, Thread } from './types.ts';

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function loadAdoLocalReview(storage: RecoveryStorage, sourceKey: string): DocThreadFileV1 | null {
  const raw = storage.getItem(sourceKey);
  if (raw === null) return null;
  const snapshot = decodeAdoReviewSnapshot(raw);
  if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.docPath !== sourceKey) {
    throw new Error('The local work-item review could not be read for this source. It has not been removed.');
  }
  return snapshot;
}

export function documentDraftKey(sourceKey: string): string {
  return `docthread:document-draft:${sourceKey}`;
}

export function storeDocumentDraft(storage: RecoveryStorage, sourceKey: string, markdown: string): void {
  const draft: DocThreadFileV1 = {
    schemaVersion: 1,
    docPath: sourceKey,
    threads: [],
    markdown,
    updatedAt: new Date().toISOString(),
  };
  storage.setItem(documentDraftKey(sourceKey), JSON.stringify(draft));
}

export function loadDocumentDraft(storage: RecoveryStorage, sourceKey: string): DocThreadFileV1 | null {
  const raw = storage.getItem(documentDraftKey(sourceKey));
  if (raw === null) return null;
  const draft = decodeDocThreadFile(JSON.parse(raw));
  if (draft.schemaVersion !== 1 || draft.docPath !== sourceKey || draft.threads.length !== 0 || typeof draft.markdown !== 'string') {
    throw new Error('The local document draft does not match this source.');
  }
  return draft;
}

export function clearDocumentDraft(storage: RecoveryStorage, sourceKey: string, expectedMarkdown: string): void {
  if (loadDocumentDraft(storage, sourceKey)?.markdown === expectedMarkdown) {
    storage.removeItem(documentDraftKey(sourceKey));
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, canonical(entry)]));
  }
  return value;
}

export function sameReviewThreads(left: Pick<DocThreadFile, 'threads'>, right: Pick<DocThreadFile, 'threads'>): boolean {
  const content = (threads: Thread[]) => threads.map(({ located: _located, confidence: _confidence, ...thread }) => thread).sort((first, second) => first.id.localeCompare(second.id));
  return JSON.stringify(canonical(content(left.threads))) === JSON.stringify(canonical(content(right.threads)));
}

export function combineAdoReviewCopies(local: DocThreadFileV1, shared: DocThreadFileV1): DocThreadFileV1 {
  if (local.schemaVersion !== 1 || shared.schemaVersion !== 1 || local.docPath !== shared.docPath) {
    throw new Error('The review copies belong to different sources or formats.');
  }
  return {
    ...shared,
    threads: mergeReviewThreads(local.threads, shared.threads),
    updatedAt: local.updatedAt > shared.updatedAt ? local.updatedAt : shared.updatedAt,
  };
}
