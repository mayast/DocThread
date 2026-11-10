import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSuggestionRequest, requestAiSuggestion } from '../src/aiSuggest.ts';
import type { Comment } from '../src/types.ts';

const T0 = '2026-08-24T10:00:00.000Z';

function comment(id: string, body: string): Comment {
  return { id, author: 'Reviewer', body, createdAt: T0 };
}

test('buildSuggestionRequest collects non-empty comment bodies as feedback', () => {
  const req = buildSuggestionRequest(
    'the anchored text',
    [comment('c1', 'Please make this active voice'), comment('c2', '  '), comment('c3', 'and shorter')],
    'My Doc'
  );
  assert.equal(req.original, 'the anchored text');
  assert.deepEqual(req.feedback, ['Please make this active voice', 'and shorter']);
  assert.equal(req.docTitle, 'My Doc');
});

test('requestAiSuggestion returns a note when no endpoint is configured (graceful)', async () => {
  const result = await requestAiSuggestion('', {
    original: 'x',
    feedback: ['do something'],
  });
  assert.deepEqual(result, { ok: false, reason: 'no endpoint configured' });
});

test('requestAiSuggestion returns a note when there is no feedback', async () => {
  const result = await requestAiSuggestion('https://ai.example/suggest', {
    original: 'x',
    feedback: [],
  });
  assert.equal(result.ok, false);
});

test('requestAiSuggestion posts the payload and returns the replacement', async () => {
  let captured: any;
  const fakeFetch = (async (_url: string, init: any) => {
    captured = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ replacement: 'the improved text' }), { status: 200 });
  }) as unknown as typeof fetch;
  const result = await requestAiSuggestion(
    'https://ai.example/suggest',
    { original: 'the text', feedback: ['make it better'] },
    fakeFetch
  );
  assert.deepEqual(result, { ok: true, replacement: 'the improved text' });
  assert.deepEqual(captured.feedback, ['make it better']);
});

test('buildSuggestionRequest can include an optional resolved skill', () => {
  const req = buildSuggestionRequest('the text', [comment('c1', 'make it better')], 'My Doc', {
    name: 'Brand Voice',
    body: 'Use active voice.',
  });
  assert.deepEqual(req.skill, { name: 'Brand Voice', body: 'Use active voice.' });
});

test('requestAiSuggestion accepts a { text } response shape too', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ text: 'via text field' }), { status: 200 })) as unknown as typeof fetch;
  const result = await requestAiSuggestion(
    'https://ai.example/suggest',
    { original: 'x', feedback: ['y'] },
    fakeFetch
  );
  assert.deepEqual(result, { ok: true, replacement: 'via text field' });
});

test('requestAiSuggestion reports an HTTP error without throwing', async () => {
  const fakeFetch = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
  const result = await requestAiSuggestion(
    'https://ai.example/suggest',
    { original: 'x', feedback: ['y'] },
    fakeFetch
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /500/);
});

test('requestAiSuggestion treats an unchanged replacement as no change', async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ replacement: 'same' }), { status: 200 })) as unknown as typeof fetch;
  const result = await requestAiSuggestion(
    'https://ai.example/suggest',
    { original: 'same', feedback: ['y'] },
    fakeFetch
  );
  assert.equal(result.ok, false);
});

test('requestAiSuggestion never throws on a network error', async () => {
  const fakeFetch = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const result = await requestAiSuggestion(
    'https://ai.example/suggest',
    { original: 'x', feedback: ['y'] },
    fakeFetch
  );
  assert.deepEqual(result, { ok: false, reason: 'network down' });
});
