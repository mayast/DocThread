import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeDocThreadFile } from '../src/reviewSchema.ts';
import { adoWorkItemDocPath, parseAdoWorkItemUrl } from '../src/source.ts';

test('decodes a fully synthetic legacy ADO review without a committed snapshot', () => {
  const target = parseAdoWorkItemUrl(
    'https://dev.azure.com/example/Docs/_workitems/edit/42'
  );
  assert.ok(target);
  assert.equal(adoWorkItemDocPath(target), 'ado:example/Docs/42');
  const snapshot = decodeDocThreadFile({
    schemaVersion: 1,
    docPath: adoWorkItemDocPath(target),
    markdown: '# Synthetic work item\n\n---\n\nExample body.\n',
    meta: {
      source: 'ado',
      title: 'Synthetic work item',
      sourceUrl: 'https://dev.azure.com/example/Docs/_workitems/edit/42',
    },
    threads: [
      {
        id: 'synthetic-thread',
        anchor: { quote: 'Example', prefix: '', suffix: ' body.', start: 0 },
        comments: [
          {
            id: 'synthetic-comment',
            author: 'Example Reviewer',
            body: 'Please clarify this sentence.',
            createdAt: '2026-08-23T10:00:00.000Z',
          },
        ],
        resolved: false,
        createdAt: '2026-08-23T10:00:00.000Z',
      },
    ],
    updatedAt: '2026-08-23T10:00:00.000Z',
  });
  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.docPath, adoWorkItemDocPath(target));
  assert.equal(snapshot.meta?.source, 'ado');
  assert.match(snapshot.markdown || '', /^# Synthetic work item/);
  assert.equal(snapshot.threads[0].comments[0].author, 'Example Reviewer');
});
