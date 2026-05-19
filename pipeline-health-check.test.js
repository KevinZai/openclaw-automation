#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveBaseUrl } from './pipeline-health-check.js';

test('resolveBaseUrl defaults to live Paperclip port 3100', () => {
  assert.equal(resolveBaseUrl({}), 'http://127.0.0.1:3100');
});

test('resolveBaseUrl prefers explicit PAPERCLIP_API_BASE_URL', () => {
  assert.equal(
    resolveBaseUrl({ PAPERCLIP_API_BASE_URL: 'http://localhost:9999/' }),
    'http://localhost:9999',
  );
});

test('resolveBaseUrl falls back to PAPERCLIP_BASE_URL and strips trailing slashes', () => {
  assert.equal(
    resolveBaseUrl({ PAPERCLIP_BASE_URL: 'http://localhost:3100///' }),
    'http://localhost:3100',
  );
});
