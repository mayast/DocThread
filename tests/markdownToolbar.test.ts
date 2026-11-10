import assert from 'node:assert/strict';
import test from 'node:test';

import {
  toggleInline,
  toggleLinePrefix,
  toggleOrderedList,
  applyCode,
  insertLink,
  insertImage,
  applyCommand,
  type Selection,
} from '../src/markdownToolbar.ts';

// Convenience: build a Selection from a string with a [ ... ] marked region.
// "he[llo] world" → text "hello world", selection over "llo".
function sel(marked: string): Selection {
  const start = marked.indexOf('[');
  const end = marked.indexOf(']') - 1;
  const text = marked.replace('[', '').replace(']', '');
  return { text, start, end };
}

// Render a Selection back into the "[ ... ]" notation for easy assertions.
function show(s: Selection): string {
  return s.text.slice(0, s.start) + '[' + s.text.slice(s.start, s.end) + ']' + s.text.slice(s.end);
}

test('bold wraps the selection and keeps it selected', () => {
  assert.equal(show(toggleInline(sel('he[llo] world'), '**')), 'he[**llo**] world');
});

test('bold toggles off when the selection is already wrapped', () => {
  assert.equal(show(toggleInline(sel('he[**llo**] world'), '**')), 'he[llo] world');
});

test('bold toggles off when markers sit just outside the selection', () => {
  assert.equal(show(toggleInline(sel('he**[llo]** world'), '**')), 'he[llo] world');
});

test('bold on an empty selection drops the caret between markers', () => {
  const r = toggleInline(sel('foo[] bar'), '**');
  assert.equal(r.text, 'foo**** bar');
  assert.equal(r.start, 5);
  assert.equal(r.end, 5);
});

test('italic uses a single asterisk', () => {
  assert.equal(show(toggleInline(sel('[hi]'), '*')), '[*hi*]');
});

test('heading prefixes the line', () => {
  assert.equal(show(toggleLinePrefix(sel('[Title]'), '## ')), '[## Title]');
});

test('heading toggles off when already present', () => {
  assert.equal(show(toggleLinePrefix(sel('[## Title]'), '## ')), '[Title]');
});

test('quote and bullet apply to every selected line', () => {
  assert.equal(show(toggleLinePrefix(sel('[a\nb]'), '> ')), '[> a\n> b]');
  assert.equal(show(toggleLinePrefix(sel('[a\nb]'), '- ')), '[- a\n- b]');
});

test('line prefix expands to whole lines from a partial selection', () => {
  // Selection covers only "b" but the prefix applies to the full line.
  assert.equal(show(toggleLinePrefix(sel('a[b]c'), '- ')), '[- abc]');
});

test('blank lines are left untouched by line prefixes', () => {
  assert.equal(show(toggleLinePrefix(sel('[a\n\nb]'), '- ')), '[- a\n\n- b]');
});

test('task list detects both checked and unchecked when toggling off', () => {
  // Content contains brackets, so build the selection directly.
  const r = toggleLinePrefix({ text: '- [x] done', start: 0, end: 10 }, '- [ ] ');
  assert.equal(r.text, 'done');
  assert.equal(r.start, 0);
  assert.equal(r.end, 4);
});

test('ordered list numbers each line and toggles off', () => {
  assert.equal(show(toggleOrderedList(sel('[a\nb\nc]'))), '[1. a\n2. b\n3. c]');
  assert.equal(show(toggleOrderedList(sel('[1. a\n2. b]'))), '[a\nb]');
});

test('code is inline for a single-line selection', () => {
  assert.equal(show(applyCode(sel('x [y] z'))), 'x [`y`] z');
});

test('code is a fenced block for a multi-line selection', () => {
  const r = applyCode(sel('[a\nb]'));
  assert.equal(r.text, '```\na\nb\n```');
  assert.equal(r.text.slice(r.start, r.end), 'a\nb');
});

test('link uses the selection as text and selects the url placeholder', () => {
  const r = insertLink(sel('see [here] now'));
  assert.equal(r.text, 'see [here](url) now');
  assert.equal(r.text.slice(r.start, r.end), 'url');
});

test('link with no selection inserts a text placeholder', () => {
  const r = insertLink(sel('go []'));
  assert.equal(r.text, 'go [text](url)');
  assert.equal(r.text.slice(r.start, r.end), 'url');
});

test('image inserts the bang prefix and alt placeholder', () => {
  const r = insertImage(sel('[]'));
  assert.equal(r.text, '![alt](url)');
  assert.equal(r.text.slice(r.start, r.end), 'url');
});

test('applyCommand dispatches by command name', () => {
  assert.equal(show(applyCommand('bold', sel('[hi]'))), '[**hi**]');
  assert.equal(show(applyCommand('task-list', sel('[buy milk]'))), '[- [ ] buy milk]');
  assert.equal(show(applyCommand('heading', sel('[Big]'))), '[## Big]');
});
