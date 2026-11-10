import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveSkillName, parseSkillPaths, resolveSkillFromText } from '../src/aiSkill.ts';

test('deriveSkillName prefers frontmatter name, then heading, then filename', () => {
  assert.equal(deriveSkillName('---\nname: API Standards\n---\n# Ignored', 'x.md'), 'API Standards');
  assert.equal(deriveSkillName('# Brand Voice\n\nUse short words.', 'brand.md'), 'Brand Voice');
  assert.equal(deriveSkillName('No heading here.', '.docthread/skills/security-review.txt'), 'Security Review');
});

test('resolveSkillFromText accepts any non-empty text file content', () => {
  const resolved = resolveSkillFromText('Use active voice.', 'CONTRIBUTING.md');
  assert.deepEqual(resolved, {
    skill: { name: 'CONTRIBUTING', body: 'Use active voice.' },
    source: 'CONTRIBUTING.md',
  });
  assert.equal(resolveSkillFromText('   ', 'SKILL.md'), null);
});

test('parseSkillPaths reads comma, semicolon, and newline separated configured paths', () => {
  assert.deepEqual(parseSkillPaths('a.md, b.txt\nc/SKILL.md; https://example.test/raw'), [
    'a.md',
    'b.txt',
    'c/SKILL.md',
    'https://example.test/raw',
  ]);
});
