/** Tests for the download URL allowlist (ETL spec §4.2, SSRF guard). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedUrl } from './nflverse.service.js';

test('isAllowedUrl accepts the nflverse host and its storage redirect target', () => {
  assert.equal(isAllowedUrl('https://github.com/nflverse/nflverse-data/releases/download/teams/x.csv'), true);
  assert.equal(isAllowedUrl('https://release-assets.githubusercontent.com/github-production-release-asset/x'), true);
});

test('isAllowedUrl rejects non-https and disallowed hosts', () => {
  assert.equal(isAllowedUrl('http://github.com/x'), false); // not https
  assert.equal(isAllowedUrl('https://evil.com/x'), false);
  assert.equal(isAllowedUrl('not a url'), false);
});

test('isAllowedUrl rejects suffix-spoofed hosts', () => {
  assert.equal(isAllowedUrl('https://github.com.evil.com/x'), false);
  assert.equal(isAllowedUrl('https://notgithubusercontent.com/x'), false);
});
