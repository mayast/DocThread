import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AdoWorkItemError,
  createAdoWorkItemClient,
  htmlToMarkdown,
  splitDocForAdo,
  workItemToMarkdown,
} from '../src/ado.ts';
import type { AdoWorkItemTarget } from '../src/source.ts';

const target: AdoWorkItemTarget = {
  kind: 'ado-workitem',
  organization: 'fabrikam',
  project: 'Docs Project',
  id: 42,
};

test('converts an ADO work item description into the shared Markdown viewer shape', () => {
  assert.equal(htmlToMarkdown('<div>First</div><div><strong>Second</strong></div>'), 'First\n\n**Second**');
  const markdown = workItemToMarkdown({
    id: 42,
    revision: 7,
    title: 'Review the PRD',
    descriptionHtml: '<p>Ship <strong>safely</strong>.</p>',
    type: 'Product Backlog Item',
    state: 'Active',
    url: 'https://dev.azure.com/fabrikam/Docs%20Project/_workitems/edit/42',
  });
  assert.match(markdown, /^# Review the PRD/);
  assert.match(markdown, /Product Backlog Item · _Active_ · #42/);
  assert.match(markdown, /Ship \*\*safely\*\*\./);
  assert.deepEqual(splitDocForAdo(markdown), {
    title: 'Review the PRD',
    body: 'Ship **safely**.',
  });
});

test('loads title and description through the Azure DevOps work-item API', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const client = createAdoWorkItemClient({
    baseUrl: 'https://dev.azure.com',
    getAccessToken: async () => 'entra-token',
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({
        id: 42,
        rev: 7,
        fields: {
          'System.Title': 'Review the PRD',
          'System.Description': '<p>Original body</p>',
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Active',
        },
      });
    },
  });

  const document = await client.fetchDocument(target);
  assert.equal(document.revision, '7');
  assert.equal(document.title, 'Review the PRD');
  assert.match(document.text, /Original body/);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/fabrikam/Docs%20Project/_apis/wit/workitems/42');
  assert.equal(url.searchParams.get('api-version'), '7.1');
  assert.match(url.searchParams.get('fields') || '', /System\.Description/);
  assert.equal(new Headers(requests[0].init?.headers).get('Authorization'), 'Bearer entra-token');
});

test('resolves a project-less work-item URL from System.TeamProject', async () => {
  let requestUrl = '';
  const client = createAdoWorkItemClient({
    fetch: async (input) => {
      requestUrl = String(input);
      return Response.json({
        id: 42,
        rev: 7,
        fields: {
          'System.Title': 'Review',
          'System.TeamProject': 'Engineering',
        },
      });
    },
  });
  const resolved = await client.resolveTarget({
    kind: 'ado-workitem',
    organization: 'fabrikam',
    id: 42,
  });
  assert.equal(resolved.project, 'Engineering');
  assert.match(new URL(requestUrl).searchParams.get('fields') || '', /System\.TeamProject/);
});

test('replaces a supplied project alias with provider-returned System.TeamProject', async () => {
  let requestUrl = '';
  const client = createAdoWorkItemClient({
    fetch: async (input) => {
      requestUrl = String(input);
      return Response.json({
        id: 42,
        rev: 7,
        fields: {
          'System.Title': 'Review',
          'System.TeamProject': 'Engineering',
        },
      });
    },
  });
  const resolved = await client.resolveTarget({ ...target, project: 'Project Alias' });
  assert.equal(resolved.project, 'Engineering');
  assert.equal(new URL(requestUrl).pathname, '/fabrikam/_apis/wit/workitems/42');
});

test('classifies the measured 203 HTML sign-in response before JSON parsing', async () => {
  const client = createAdoWorkItemClient({
    fetch: async () =>
      new Response('<!doctype html><title>Sign in</title>', {
        status: 203,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
  });
  await assert.rejects(
    client.fetchDocument(target),
    (error) =>
      error instanceof AdoWorkItemError &&
      error.kind === 'signin-required' &&
      error.status === 203 &&
      /Sign in to Microsoft/.test(error.message)
  );
});

test('reconciles to the live revision and preserves it in the optimistic check', async () => {
  let request: { url: string; init?: RequestInit } | undefined;
  const client = createAdoWorkItemClient({
    baseUrl: 'https://dev.azure.com',
    getAccessToken: async () => 'entra-token',
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return Response.json({
        id: 42,
        rev: 8,
        fields: {
          'System.Title': 'Updated PRD',
          'System.Description': '<p>Changed <strong>body</strong>.</p>',
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Active',
        },
      });
    },
  });

  // Caller passes a stale revision ('7'); updateDocument re-reads the work item
  // (which is at rev 8) and uses the live rev in the /rev test op, so our own
  // review-saves bumping /rev never cause a phantom VS403351 conflict.
  const updated = await client.updateDocument(
    target,
    '# Updated PRD\n\nProduct Backlog Item · _Active_ · #42\n\n---\n\nChanged **body**.',
    '7'
  );
  assert.equal(updated.revision, '8');
  assert.equal(request?.init?.method, 'PATCH');
  assert.equal(
    new Headers(request?.init?.headers).get('Content-Type'),
    'application/json-patch+json'
  );
  assert.deepEqual(JSON.parse(String(request?.init?.body)), [
    { op: 'test', path: '/rev', value: 8 },
    { op: 'add', path: '/fields/System.Title', value: 'Updated PRD' },
    {
      op: 'add',
      path: '/fields/System.Description',
      value: '<p>Changed <strong>body</strong>.</p>',
    },
  ]);
});

test('preserves a description-mode review marker when the doc body is edited', async () => {
  // A hidden review marker (base64 of {schemaVersion:1,threads:[]}) lives in the
  // work item description alongside the human body. Editing/saving the doc must
  // re-attach the marker so "description" mode reviews are not silently dropped.
  const markerB64 = 'eyJzY2hlbWFWZXJzaW9uIjoxLCJ0aHJlYWRzIjpbXX0=';
  const currentDescription =
    '<p>Old body.</p><div style="display:none">docthread-review:v1 ' + markerB64 + '</div>';
  let patchBody: any;
  const client = createAdoWorkItemClient({
    baseUrl: 'https://dev.azure.com',
    getAccessToken: async () => 'entra-token',
    fetch: async (input, init) => {
      if ((init?.method || 'GET').toUpperCase() === 'PATCH') {
        patchBody = JSON.parse(String(init?.body));
      }
      return Response.json({
        id: 42,
        rev: 5,
        fields: {
          'System.Title': 'PRD',
          'System.Description': currentDescription,
          'System.WorkItemType': 'Product Backlog Item',
          'System.State': 'Active',
        },
      });
    },
  });

  await client.updateDocument(
    target,
    '# PRD\n\nProduct Backlog Item · _Active_ · #42\n\n---\n\nNew body.',
    '5'
  );

  const descOp = patchBody.find(
    (op: any) => op.path === '/fields/System.Description'
  );
  assert.ok(descOp, 'expected a System.Description patch op');
  assert.match(descOp.value, /New body\./);
  assert.match(descOp.value, /docthread-review:v1\s+[A-Za-z0-9+/=]+/);
  assert.match(descOp.value, /display:none/);
});
