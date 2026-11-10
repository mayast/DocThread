import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseAllowedDomains,
  isAllowedRecipient,
  filterAllowedRecipients,
  DEFAULT_ALLOWED_DOMAINS,
} from '../src/notifyAllowlist.ts';

test('parseAllowedDomains normalizes and falls back to the default', () => {
  assert.deepEqual(parseAllowedDomains('Contoso.com, @fabrikam.com '), [
    'contoso.com',
    'fabrikam.com',
  ]);
  assert.deepEqual(parseAllowedDomains(''), DEFAULT_ALLOWED_DOMAINS);
  assert.deepEqual(parseAllowedDomains(undefined), DEFAULT_ALLOWED_DOMAINS);
});

test('isAllowedRecipient matches exact and subdomain addresses only', () => {
  const domains = ['microsoft.com'];
  assert.equal(isAllowedRecipient('maya@microsoft.com', domains), true);
  assert.equal(isAllowedRecipient('maya@sub.microsoft.com', domains), true);
  assert.equal(isAllowedRecipient('maya@evil.com', domains), false);
  // No lookalike bypass: notmicrosoft.com must not match microsoft.com.
  assert.equal(isAllowedRecipient('a@notmicrosoft.com', domains), false);
  assert.equal(isAllowedRecipient('not-an-email', domains), false);
  assert.equal(isAllowedRecipient('', domains), false);
});

test('filterAllowedRecipients keeps allowed, dedupes, drops the rest', () => {
  const out = filterAllowedRecipients(
    ['maya@microsoft.com', 'MAYA@microsoft.com', ' bob@microsoft.com ', 'x@evil.com'],
    ['microsoft.com']
  );
  assert.deepEqual(out, ['maya@microsoft.com', 'bob@microsoft.com']);
  assert.deepEqual(filterAllowedRecipients(['x@evil.com'], ['microsoft.com']), []);
  assert.deepEqual(filterAllowedRecipients('nope', ['microsoft.com']), []);
});
