// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Claude Code vendor forks keep the same `projects/<slug>/<uuid>.jsonl` layout.
// They are registered as separate providers so `source` records which CLI wrote
// a row. These tests pin the two consequences: namespaced session ids and an
// independent replay marker.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLAUDE_CANONICAL_TRANSCRIPT_MARKER,
  createClaudeProvider,
} from '../packages/core/src/providers/claude.ts';
import { makeTempDir } from './temp-dirs.mjs';

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) {
    values.push(step.value);
    step = gen.next();
  }
  return values;
}

function writeVariantSession(root, sessionId = 'sid-1') {
  const dir = join(root, 'projects', '-proj-app');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  writeFileSync(path, [
    JSON.stringify({ type: 'ai-title', aiTitle: 'Variant session' }),
    JSON.stringify({
      uuid: 'u1', type: 'user', timestamp: '2026-08-01T10:00:00.000Z', cwd: '/proj/app',
      message: { role: 'user', content: 'hello from the fork' },
    }),
    JSON.stringify({
      uuid: 'a1', type: 'assistant', timestamp: '2026-08-01T10:00:05.000Z', cwd: '/proj/app',
      message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'text', text: 'hi' }] },
    }),
  ].join('\n') + '\n');
  return path;
}

test('claude fork: a non-default id namespaces session ids and stamps its own source', () => {
  const root = makeTempDir('obelisk-claude-fork-');
  writeVariantSession(root);
  const provider = createClaudeProvider({
    rootDir: root,
    id: 'claude-tme',
    displayName: 'Claude Code (TME)',
    vendor: 'Tencent TME fork',
  });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1);
  assert.equal(units[0].sessionId, 'claude-tme:sid-1');

  const records = drain(provider.parse(units[0], null));
  const session = records.find((record) => record.kind === 'session');
  assert.equal(session.id, 'claude-tme:sid-1');
  assert.equal(session.source, 'claude-tme');
  assert.equal(session.title, 'Variant session');

  const message = records.find((record) => record.kind === 'message');
  assert.equal(message.session_id, 'claude-tme:sid-1');
  assert.equal(message.source, 'claude-tme');
});

test('claude fork: forks never share a replay marker with the default provider', () => {
  const fork = createClaudeProvider({ rootDir: '/tmp/x', id: 'claude-lens', displayName: 'Claude Code (Lens)' });
  const base = createClaudeProvider({ rootDir: '/tmp/x' });
  assert.equal(base.indexVersionMarker, CLAUDE_CANONICAL_TRANSCRIPT_MARKER);
  assert.notEqual(fork.indexVersionMarker, CLAUDE_CANONICAL_TRANSCRIPT_MARKER);
  assert.match(String(fork.indexVersionMarker), /claude-lens/);
  assert.equal(fork.name, fork.descriptor.id);
  assert.equal(fork.descriptor.name, 'Claude Code (Lens)');
});

test('claude fork: the default provider keeps bare session ids and the historical source tag', () => {
  const root = makeTempDir('obelisk-claude-default-');
  writeVariantSession(root);
  const provider = createClaudeProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  assert.equal(unit.sessionId, 'sid-1');
  const session = drain(provider.parse(unit, null)).find((record) => record.kind === 'session');
  assert.equal(session.id, 'sid-1');
  assert.equal(session.source, 'claude');
});
