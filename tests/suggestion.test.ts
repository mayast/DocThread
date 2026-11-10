import assert from 'node:assert/strict';
import test from 'node:test';

import { applySuggestion, isSuggestionApplied, diffLines } from '../src/suggestion.ts';
import type { Anchor } from '../src/types.ts';

function anchorFor(text: string, quote: string): Anchor {
  const start = text.indexOf(quote);
  return {
    quote,
    prefix: text.slice(Math.max(0, start - 20), start),
    suffix: text.slice(start + quote.length, start + quote.length + 20),
    start,
  };
}

test('applySuggestion replaces exactly the anchored span', () => {
  const text = 'The quick brown fox jumps.';
  const anchor = anchorFor(text, 'quick brown');
  const result = applySuggestion(text, anchor, 'slow red');
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.text, 'The slow red fox jumps.');
    // The returned selection covers the inserted replacement.
    assert.equal(result.text.slice(result.start, result.end), 'slow red');
  }
});

test('applySuggestion still applies after text changed above the anchor (re-anchoring)', () => {
  const original = 'Intro line.\nThe quick brown fox jumps.';
  const anchor = anchorFor(original, 'quick brown');
  // Simulate the document being edited above the anchor before Apply.
  const edited = 'A new first paragraph was added.\n\nIntro line.\nThe quick brown fox jumps.';
  const result = applySuggestion(edited, anchor, 'slow red');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text.includes('The slow red fox jumps.'), true);
});

test('applySuggestion reports stale when the anchor can no longer be found', () => {
  const anchor = anchorFor('The quick brown fox.', 'quick brown');
  const result = applySuggestion('Completely different document text.', anchor, 'x');
  assert.deepEqual(result, { ok: false, reason: 'stale' });
});

test('applySuggestion supports deletion (empty replacement)', () => {
  const text = 'Remove THIS please.';
  const anchor = anchorFor(text, 'THIS ');
  const result = applySuggestion(text, anchor, '');
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.text, 'Remove please.');
});

test('isSuggestionApplied reflects appliedAt', () => {
  assert.equal(isSuggestionApplied(undefined), false);
  assert.equal(isSuggestionApplied({ appliedAt: undefined }), false);
  assert.equal(isSuggestionApplied({ appliedAt: '2026-08-28T10:00:00.000Z' }), true);
});

test('diffLines marks removed/added lines with shared context', () => {
  const diff = diffLines('one\ntwo\nthree', 'one\nTWO\nthree');
  assert.deepEqual(diff, [
    { kind: 'context', text: 'one' },
    { kind: 'removed', text: 'two' },
    { kind: 'added', text: 'TWO' },
    { kind: 'context', text: 'three' },
  ]);
});

test('diffLines on a single-line change emits removed then added', () => {
  const diff = diffLines('quick brown', 'slow red');
  assert.deepEqual(diff, [
    { kind: 'removed', text: 'quick brown' },
    { kind: 'added', text: 'slow red' },
  ]);
});
