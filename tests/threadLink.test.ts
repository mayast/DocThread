import assert from 'node:assert/strict';
import test from 'node:test';

import { withThreadParam, readThreadParam, THREAD_PARAM } from '../src/threadLink.ts';

const BASE = 'https://app.example.com/docthread/';

test('withThreadParam appends the thread id and preserves existing params', () => {
  const url = withThreadParam(`${BASE}?source=github&doc=abc`, 'th-42');
  const params = new URL(url).searchParams;
  assert.equal(params.get('source'), 'github');
  assert.equal(params.get('doc'), 'abc');
  assert.equal(params.get(THREAD_PARAM), 'th-42');
});

test('withThreadParam replaces an existing thread id rather than duplicating it', () => {
  const url = withThreadParam(`${BASE}?thread=old`, 'new');
  const params = new URL(url).searchParams;
  assert.deepEqual(params.getAll(THREAD_PARAM), ['new']);
});

test('withThreadParam adds a query string when none exists', () => {
  const url = withThreadParam(BASE, 'th-1');
  assert.equal(new URL(url).searchParams.get(THREAD_PARAM), 'th-1');
});

test('readThreadParam returns the id when present', () => {
  assert.equal(readThreadParam('?thread=th-9&foo=bar'), 'th-9');
  assert.equal(readThreadParam('thread=th-9'), 'th-9');
});

test('readThreadParam returns null when absent or blank', () => {
  assert.equal(readThreadParam(''), null);
  assert.equal(readThreadParam('?foo=bar'), null);
  assert.equal(readThreadParam('?thread='), null);
  assert.equal(readThreadParam('?thread=%20%20'), null);
});

test('readThreadParam trims surrounding whitespace', () => {
  assert.equal(readThreadParam('?thread=%20th-7%20'), 'th-7');
});

test('encode then decode round-trips the thread id', () => {
  const id = 'thread-abc_123';
  const url = withThreadParam(`${BASE}?doc=x`, id);
  assert.equal(readThreadParam(new URL(url).search), id);
});
