import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectReviewStatus,
  formatSummary,
  formatTitle,
  reviewDocumentUrl,
  reviewTargets,
  sidecarPath,
  v1SidecarPath,
  v2SidecarPath,
} from './docthread-review.mjs';

const UPDATED_AT = '2026-08-21T00:00:00Z';

const CANONICAL_V2_PATH_VECTORS = [
  ['a/b.md', '.docthread/v2/a/b.md.json'],
  ['a__b.md', '.docthread/v2/a__b.md.json'],
  ['docs/review notes.md', '.docthread/v2/docs/review%20notes.md.json'],
  ['docs/caf\u00e9.md', '.docthread/v2/docs/caf%C3%A9.md.json'],
  ['docs/cafe\u0301.md', '.docthread/v2/docs/cafe%CC%81.md.json'],
  ["docs/what's (new)!.md", '.docthread/v2/docs/what%27s%20%28new%29%21.md.json'],
];

function temporaryRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docthread-review-'));
}

function writeSidecar(root, relativePath, value) {
  const fullPath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, JSON.stringify(value));
}

let threadSequence = 0;
function thread({ resolved = false, intent, deletedAt } = {}) {
  threadSequence += 1;
  return {
    id: `thread-${threadSequence}`,
    anchor: { quote: 'review', prefix: '', suffix: '', start: 0 },
    comments: [],
    resolved,
    createdAt: UPDATED_AT,
    ...(intent === undefined ? {} : { intent }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}

function v1File(docPath, threads = []) {
  return { schemaVersion: 1, docPath, updatedAt: UPDATED_AT, threads };
}

function v2File(docPath, threads = [], extra = {}) {
  return {
    schemaVersion: 2,
    source: { provider: 'github', path: docPath },
    docPath,
    updatedAt: UPDATED_AT,
    threads,
    ...extra,
  };
}

test('uses the shared canonical v2 path vectors without normalizing raw segments', () => {
  for (const [docPath, expected] of CANONICAL_V2_PATH_VECTORS) {
    assert.equal(v2SidecarPath(docPath), expected);
  }
  assert.notEqual(v2SidecarPath('a/b.md'), v2SidecarPath('a__b.md'));
  assert.notEqual(v2SidecarPath('docs/caf\u00e9.md'), v2SidecarPath('docs/cafe\u0301.md'));

  for (const invalid of [
    '',
    '/a.md',
    'a.md/',
    'a//b.md',
    './a.md',
    'a/./b.md',
    'a/../b.md',
    'a\\b.md',
  ]) {
    assert.throws(() => v2SidecarPath(invalid), /Repository paths/);
  }
});

test('recognizes Markdown, v2, and v1 changes without decoding a v1 filename', () => {
  assert.equal(sidecarPath('docs/design.md'), '.docthread/docs__design.md.json');
  assert.equal(v1SidecarPath('docs/design.md'), '.docthread/docs__design.md.json');
  const targets = reviewTargets([
    'docs/design.md',
    '.docthread/v2/docs/design.md.json',
    '.docthread/docs__design.md.json',
  ]);
  assert.deepEqual(
    targets.map(({ kind, docPath }) => ({ kind, docPath })),
    [
      { kind: 'v1-sidecar', docPath: null },
      { kind: 'v2-sidecar', docPath: null },
      { kind: 'document', docPath: 'docs/design.md' },
    ]
  );
});

test('uses v2 authoritatively when both sidecars exist', () => {
  const root = temporaryRoot();
  const docPath = 'docs/design.md';
  writeSidecar(root, v1SidecarPath(docPath), v1File(docPath, [thread(), thread()]));
  writeSidecar(
    root,
    v2SidecarPath(docPath),
    v2File(docPath, [thread({ intent: 'blocking' })])
  );

  const status = collectReviewStatus(root, [docPath], {
    provider: 'github',
    repository: 'gim-home/DocThread',
    ref: 'abc123',
  });
  assert.equal(status.documents[0].sidecar, v2SidecarPath(docPath));
  assert.equal(status.open, 1);
  assert.equal(status.blocking, 1);
  assert.equal(status.documents[0].url, 'https://github.com/gim-home/DocThread/blob/abc123/docs/design.md');
  assert.equal(formatTitle(status), 'DocThread review: 1 open, 1 blocking');
  assert.match(formatSummary(status), /reporting-only/);
});

test('reads an exact v1 fallback and counts only nondeleted unresolved threads', () => {
  const root = temporaryRoot();
  const docPath = 'docs/design.md';
  writeSidecar(
    root,
    v1SidecarPath(docPath),
    v1File(docPath, [
      thread(),
      thread({ intent: 'blocking' }),
      thread({ resolved: true, intent: 'blocking' }),
      thread({ intent: 'blocking', deletedAt: UPDATED_AT }),
    ])
  );

  const status = collectReviewStatus(root, [docPath]);
  assert.equal(status.documents[0].sidecar, v1SidecarPath(docPath));
  assert.equal(status.open, 2);
  assert.equal(status.blocking, 1);
  assert.equal(status.warnings.length, 0);
});

test('accepts an exact provider and ref v1 storage key', () => {
  const root = temporaryRoot();
  const docPath = 'docs/design.md';
  writeSidecar(
    root,
    v1SidecarPath(docPath),
    v1File(`gim-home/DocThread/${docPath}@feature/review`, [thread()])
  );

  const status = collectReviewStatus(root, [docPath], {
    provider: 'github',
    repository: 'gim-home/DocThread',
    ref: 'feature/review',
  });
  assert.equal(status.open, 1);
  assert.equal(status.warnings.length, 0);
});

test('quarantines a colliding v1 fallback instead of loading the other document', () => {
  const root = temporaryRoot();
  writeSidecar(root, v1SidecarPath('a__b.md'), v1File('a/b.md', [thread()]));

  const status = collectReviewStatus(root, ['a__b.md']);
  assert.equal(status.documents.length, 0);
  assert.equal(status.open, 0);
  assert.equal(status.missing.length, 0);
  assert.equal(status.warnings.length, 1);
  assert.match(status.warnings[0], /quarantined.*may collide/);
  assert.match(formatSummary(status), /Review warnings/);
});

test('ignores v2 deletion tombstones when counting status', () => {
  const root = temporaryRoot();
  const docPath = 'docs/design.md';
  writeSidecar(
    root,
    v2SidecarPath(docPath),
    v2File(docPath, [
      thread({ intent: 'blocking', deletedAt: UPDATED_AT }),
      thread({ intent: 'blocking' }),
      thread({ resolved: true }),
    ])
  );

  const status = collectReviewStatus(root, [docPath], { provider: 'github' });
  assert.equal(status.open, 1);
  assert.equal(status.blocking, 1);
});

test('rejects unknown and malformed sidecars clearly', () => {
  const unknownRoot = temporaryRoot();
  const docPath = 'docs/design.md';
  writeSidecar(unknownRoot, v2SidecarPath(docPath), {
    schemaVersion: 3,
    docPath,
    updatedAt: UPDATED_AT,
    threads: [],
  });
  assert.throws(
    () => collectReviewStatus(unknownRoot, [docPath]),
    /schemaVersion.*unknown or missing/
  );

  const malformedRoot = temporaryRoot();
  writeSidecar(malformedRoot, v2SidecarPath(docPath), {
    ...v2File(docPath),
    threads: {},
  });
  assert.throws(() => collectReviewStatus(malformedRoot, [docPath]), /\.threads.*array/);
});

test('rejects malformed thread cores and local-only remote comments', () => {
  const malformedRoot = temporaryRoot();
  const malformedPath = v2SidecarPath('docs/malformed.md');
  writeSidecar(malformedRoot, malformedPath, v2File('docs/malformed.md', [{ resolved: true }]));
  assert.throws(
    () => collectReviewStatus(malformedRoot, [malformedPath], { provider: 'github' }),
    /\.id: expected a non-empty string/
  );

  const localOnlyRoot = temporaryRoot();
  const localOnlyPath = v2SidecarPath('docs/local.md');
  const localOnlyThread = thread();
  localOnlyThread.comments.push({
    id: 'local-comment',
    author: 'You',
    authorIdentityKeys: [],
    identityVersion: 1,
    localOnly: true,
    mentions: [],
    body: 'Local only',
    createdAt: UPDATED_AT,
  });
  writeSidecar(localOnlyRoot, localOnlyPath, v2File('docs/local.md', [localOnlyThread]));
  assert.throws(
    () => collectReviewStatus(localOnlyRoot, [localOnlyPath], { provider: 'github' }),
    /localOnly: not allowed in a remote sidecar/
  );
});

test('rejects duplicate comment IDs across threads and compares timestamp instants', () => {
  const root = temporaryRoot();
  const duplicatePath = v2SidecarPath('docs/duplicate.md');
  const first = thread();
  const second = thread();
  const sharedComment = {
    id: 'shared-comment',
    author: 'Reviewer',
    body: 'Review',
    createdAt: UPDATED_AT,
  };
  first.comments.push(sharedComment);
  second.comments.push({ ...sharedComment });
  writeSidecar(root, duplicatePath, v2File('docs/duplicate.md', [first, second]));
  assert.throws(
    () => collectReviewStatus(root, [duplicatePath], { provider: 'github' }),
    /comment IDs must be unique across the file/
  );

  const timestampRoot = temporaryRoot();
  const timestampPath = v2SidecarPath('docs/timestamp.md');
  const deleted = thread({ deletedAt: '2026-08-24T00:00:00.100Z' });
  deleted.createdAt = '2026-08-24T00:00:00Z';
  writeSidecar(timestampRoot, timestampPath, v2File('docs/timestamp.md', [deleted]));
  assert.equal(
    collectReviewStatus(timestampRoot, [timestampPath], { provider: 'github' }).open,
    0
  );
});

test('validates v2 persisted provider and raw path against the requested document', () => {
  const root = temporaryRoot();
  const requestedPath = 'docs/design.md';
  writeSidecar(root, v2SidecarPath(requestedPath), v2File('docs/other.md'));
  assert.throws(
    () => collectReviewStatus(root, [requestedPath], { provider: 'github' }),
    /source\.path.*does not exactly match/
  );

  const providerRoot = temporaryRoot();
  writeSidecar(providerRoot, v2SidecarPath(requestedPath), {
    ...v2File(requestedPath),
    source: { provider: 'azure-repos', path: requestedPath },
  });
  assert.throws(
    () => collectReviewStatus(providerRoot, [requestedPath], { provider: 'github' }),
    /source\.provider.*expected github/
  );
});

test('uses persisted source.path for a directly changed v2 sidecar', () => {
  const root = temporaryRoot();
  const docPath = 'docs/review notes.md';
  const sidecar = v2SidecarPath(docPath);
  writeSidecar(root, sidecar, v2File(docPath, [thread()]));

  const status = collectReviewStatus(root, [sidecar], { provider: 'github' });
  assert.equal(status.documents.length, 1);
  assert.equal(status.documents[0].docPath, docPath);
  assert.equal(status.documents[0].sidecar, sidecar);
  assert.equal(status.open, 1);
});

test('uses persisted docPath for a directly changed exact v1 sidecar', () => {
  const root = temporaryRoot();
  const docPath = 'docs/design.md';
  const sidecar = v1SidecarPath(docPath);
  writeSidecar(root, sidecar, v1File(docPath, [thread()]));

  const status = collectReviewStatus(root, [sidecar]);
  assert.equal(status.documents.length, 1);
  assert.equal(status.documents[0].docPath, docPath);
  assert.equal(status.documents[0].sidecar, sidecar);
});

test('warns deterministically when a changed v1 needs reconciliation with v2', () => {
  const root = temporaryRoot();
  const docPath = 'docs/design.md';
  const legacyPath = v1SidecarPath(docPath);
  const v2Path = v2SidecarPath(docPath);
  writeSidecar(root, legacyPath, v1File(docPath, [thread(), thread()]));
  writeSidecar(
    root,
    v2Path,
    v2File(docPath, [thread()], { legacyPath, legacyRevision: 'legacy-blob-at-migration' })
  );

  const status = collectReviewStatus(root, [legacyPath, v2Path], { provider: 'github' });
  assert.equal(status.documents[0].sidecar, v2Path);
  assert.equal(status.open, 1);
  assert.equal(status.warnings.length, 1);
  assert.match(status.warnings[0], /Legacy client changes need reconciliation/);
  assert.match(status.warnings[0], /cannot be compared from the worktree alone/);
});

test('reports changed Markdown documents that have no sidecar', () => {
  const root = temporaryRoot();
  const status = collectReviewStatus(root, ['README.md']);
  assert.equal(status.open, 0);
  assert.equal(status.missing.length, 1);
  assert.match(formatSummary(status), /README\.md/);
});

test('escapes repository-controlled paths in trusted Markdown summaries', () => {
  const path = 'docs/review](https:%2F%2Fattacker.example%2Ffake)|`x`.md';
  const summary = formatSummary({
    open: 1,
    blocking: 0,
    documents: [
      {
        docPath: path,
        sidecar: v2SidecarPath(path),
        url: 'https://docthread.example/?target=safe',
        open: 1,
        blocking: 0,
      },
    ],
    missing: [{ docPath: path, sidecar: v2SidecarPath(path) }],
    warnings: [`Review warning for \`${path}\``],
  });
  assert.doesNotMatch(summary, /\[docs\/review\]\(https:/);
  assert.doesNotMatch(summary, /\|`x`/);
  assert.match(
    summary,
    /<code>docs\/review\]\(https:%2F%2Fattacker\.example%2Ffake\)&#124;`x`\.md<\/code>/
  );
  assert.match(summary, /Review warning for \\`docs\/review/);
});

test('links GitHub documents with a canonical commit target', () => {
  const ref = 'ABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD';
  const link = new URL(
    reviewDocumentUrl(
      {
        provider: 'github',
        appUrl: 'https://docthread.example/',
        repository: 'contoso/handbook',
        ref,
      },
      'guides/review notes.md'
    )
  );
  assert.equal(link.searchParams.get('targetVersion'), '1');
  const target = JSON.parse(
    Buffer.from(link.searchParams.get('target'), 'base64url').toString('utf8')
  );
  assert.deepEqual(target, {
    kind: 'github',
    owner: 'contoso',
    repo: 'handbook',
    versionType: 'commit',
    ref: ref.toLowerCase(),
    path: 'guides/review notes.md',
  });
  assert.equal(link.searchParams.has('doc'), false);
});

test('links Azure Repos documents through the configured DocThread app', () => {
  const link = new URL(
    reviewDocumentUrl(
      {
        provider: 'azure-repos',
        appUrl: 'https://docthread.example/',
        collectionUri: 'https://dev.azure.com/fabrikam/',
        project: 'Docs Project',
        repository: 'handbook',
        ref: 'feature/comments',
      },
      'guides/review notes.md'
    )
  );
  assert.equal(link.searchParams.get('source'), 'azure-repos');
  const source = new URL(link.searchParams.get('doc'));
  assert.equal(source.pathname, '/fabrikam/Docs%20Project/_git/handbook');
  assert.equal(source.searchParams.get('path'), '/guides/review notes.md');
  assert.equal(source.searchParams.get('version'), 'GBfeature/comments');
});

test('pins Azure Repos analyzer links to the immutable build commit', () => {
  const ref = 'abcdefabcdefabcdefabcdefabcdefabcdefabcd';
  const link = new URL(
    reviewDocumentUrl(
      {
        provider: 'azure-repos',
        appUrl: 'https://docthread.example/',
        collectionUri: 'https://dev.azure.com/fabrikam/',
        project: 'Docs',
        repository: 'handbook',
        ref,
      },
      'README.md'
    )
  );
  const source = new URL(link.searchParams.get('doc'));
  assert.equal(source.searchParams.get('version'), `GC${ref}`);
});
