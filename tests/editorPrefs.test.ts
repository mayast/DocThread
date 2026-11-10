import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseSpellCheckPref,
  serializeSpellCheckPref,
  parseEditorViewMode,
} from '../src/editorPrefs.ts';

test('parseSpellCheckPref defaults to on for missing/unset values', () => {
  assert.equal(parseSpellCheckPref(null), true);
  assert.equal(parseSpellCheckPref(undefined), true);
  assert.equal(parseSpellCheckPref(''), true);
});

test('parseSpellCheckPref is off only for the explicit "0"', () => {
  assert.equal(parseSpellCheckPref('0'), false);
  assert.equal(parseSpellCheckPref('1'), true);
  assert.equal(parseSpellCheckPref('nonsense'), true);
});

test('serialize/parse round-trips both states', () => {
  assert.equal(parseSpellCheckPref(serializeSpellCheckPref(true)), true);
  assert.equal(parseSpellCheckPref(serializeSpellCheckPref(false)), false);
});

test('parseEditorViewMode accepts known modes and defaults to editor', () => {
  assert.equal(parseEditorViewMode('editor'), 'editor');
  assert.equal(parseEditorViewMode('split'), 'split');
  assert.equal(parseEditorViewMode('preview'), 'preview');
  assert.equal(parseEditorViewMode(null), 'editor');
  assert.equal(parseEditorViewMode('nonsense'), 'editor');
});
