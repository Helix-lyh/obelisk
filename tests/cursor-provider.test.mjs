// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Cursor adapter contract: the store is a content-addressed blob DAG whose
// leaves are JSON messages. These tests build a real SQLite store so the
// protobuf walk, the hex-encoded descriptor, and the projection are all
// exercised against the same shapes Cursor writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { createCursorProvider } from '../packages/core/src/providers/cursor.ts';
import { makeTempDir } from './temp-dirs.mjs';

function drain(gen) {
  const values = [];
  let step = gen.next();
  while (!step.done) {
    values.push(step.value);
    step = gen.next();
  }
  return { values, cursor: step.value };
}

function hashOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// One internal DAG node: repeated field 1, each a 32-byte child id.
function writeBranch(db, children) {
  const data = Buffer.concat(children.flatMap((child) => [
    Buffer.from([0x0a, 0x20]),
    child,
  ]));
  const id = hashOf(data);
  db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(id, data);
  return Buffer.from(id, 'hex');
}

function writeMessage(db, message) {
  const data = Buffer.from(JSON.stringify(message), 'utf8');
  const id = hashOf(data);
  db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(id, data);
  return Buffer.from(id, 'hex');
}

const MESSAGES = [
  { role: 'system', content: 'You are a coding agent.' },
  { role: 'user', content: '<user_info>\nWorkspace Path: /proj/app\n</user_info>' },
  { role: 'user', content: [{ type: 'text', text: 'why is the build red?' }] },
  {
    role: 'assistant',
    content: [
      { type: 'redacted-reasoning', data: 'opaque' },
      { type: 'text', text: 'Checking the log.' },
      { type: 'tool-call', toolCallId: 'tool_1', toolName: 'Read', args: { path: '/proj/app/build.log' } },
    ],
    providerOptions: { cursor: { systemPromptFingerprint: { model: 'composer-2.5' } } },
  },
  {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId: 'tool_1', toolName: 'Read', result: 'error: module not found' }],
    providerOptions: { cursor: { highLevelToolCallResult: { isError: false } } },
  },
  { role: 'assistant', content: [{ type: 'text', text: 'The import path is wrong.' }] },
];

function writeStore(root, { sessionId = 'sid-1', bucket = 'bucket-a', messages = MESSAGES, descriptor = {} } = {}) {
  const dir = join(root, 'chats', bucket, sessionId);
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, 'store.db');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  // Leaves are linked newest-last, matching Cursor's graph order.
  const leaves = messages.map((message) => writeMessage(db, message));
  const rootId = writeBranch(db, leaves);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({
    agentId: sessionId,
    latestRootBlobId: rootId.toString('hex'),
    name: 'Sticker Wall Guide',
    createdAt: 1_755_000_000_000,
    blobEncryptionKey: 'f'.repeat(64),
    ...descriptor,
  }), 'utf8').toString('hex'));
  db.close();
  return { dbPath, dir };
}

test('cursor: discovery finds both chats/<bucket>/<session> and acp-sessions/<session>', () => {
  const root = makeTempDir('obelisk-cursor-discover-');
  writeStore(root, { sessionId: 'sid-1' });
  const acpDir = join(root, 'acp-sessions', 'acp-1');
  mkdirSync(acpDir, { recursive: true });
  const db = new DatabaseSync(join(acpDir, 'store.db'));
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  const rootId = writeBranch(db, MESSAGES.map((message) => writeMessage(db, message)));
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({
    latestRootBlobId: rootId.toString('hex'),
    createdAt: 1_755_000_000_000,
  }), 'utf8').toString('hex'));
  db.close();
  writeFileSync(join(acpDir, 'meta.json'), JSON.stringify({
    schemaVersion: 1, cwd: '/proj/acp', title: JSON.stringify({ title: 'ACP Session' }),
  }));

  const provider = createCursorProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.deepEqual(
    units.map((unit) => unit.sessionId).sort(),
    ['acp-acp-1', 'sid-1'],
  );
  const acpUnit = units.find((unit) => unit.sessionId === 'acp-acp-1');
  assert.equal(acpUnit.project, '-proj-acp');
});

test('cursor: parse walks the blob DAG and projects messages, tool calls, and tool results', () => {
  const root = makeTempDir('obelisk-cursor-parse-');
  const { dbPath } = writeStore(root);
  const provider = createCursorProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values, cursor } = drain(provider.parse(unit, null));

  const session = values.find((record) => record.kind === 'session');
  assert.equal(session.id, 'sid-1');
  assert.equal(session.title, 'Sticker Wall Guide');
  assert.equal(session.project, '-proj-app');
  assert.equal(session.source, 'cursor');
  assert.equal(session.jsonl_path, dbPath);
  assert.equal(session.message_count, 4);

  const types = values
    .filter((record) => record.kind === 'message')
    .map((record) => record.type);
  assert.deepEqual(types, ['system', 'user', 'user', 'assistant', 'assistant']);

  const system = values.find((record) => record.kind === 'message' && record.type === 'system');
  assert.equal(system.visibility, 'hidden');
  assert.equal(system.is_meta, 1);

  const calls = values.filter((record) => record.kind === 'tool_call');
  assert.equal(calls.length, 1);
  // `tool_1` is what Cursor mints for every store, and `tool_calls.id` is the
  // primary key, so the call id has to carry its session.
  assert.equal(calls[0].id, 'cursor-sid-1-tc-tool_1');
  assert.equal(calls[0].name, 'Read');
  assert.match(calls[0].input_json, /build\.log/);

  const results = values.filter((record) => record.kind === 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_use_id, 'cursor-sid-1-tc-tool_1');
  assert.match(results[0].content, /module not found/);

  const assistant = values.find((record) => record.kind === 'message' && record.type === 'assistant');
  assert.equal(assistant.model, 'composer-2.5');

  assert.equal(typeof cursor, 'string');
});

test('cursor: a fully opaque store still yields a session row instead of vanishing', () => {
  const root = makeTempDir('obelisk-cursor-opaque-');
  const dir = join(root, 'chats', 'bucket-a', 'sid-opaque');
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, 'store.db'));
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)');
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  // An encrypted leaf: neither JSON nor a branch node.
  const leaf = Buffer.from([0x1a, 0x04, 0xde, 0xad, 0xbe, 0xef]);
  db.prepare('INSERT INTO blobs (id, data) VALUES (?, ?)').run(hashOf(leaf), leaf);
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({
    latestRootBlobId: hashOf(leaf),
    createdAt: 1_755_000_000_000,
  }), 'utf8').toString('hex'));
  db.close();

  const provider = createCursorProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const session = values.find((record) => record.kind === 'session');
  assert.equal(session.message_count, 0);
  const notice = values.find((record) => record.kind === 'message' && record.content_type === 'notice');
  assert.match(notice.text, /opaque blob/);
});

test('cursor: an unchanged store signature is skipped on the next discovery', () => {
  const root = makeTempDir('obelisk-cursor-skip-');
  const { dbPath } = writeStore(root);
  const provider = createCursorProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { cursor } = drain(provider.parse(unit, null));
  const next = provider.discover({ lastCursor: (key) => (key === dbPath ? cursor : null) });
  assert.equal(next.length, 0);
});

test('cursor: an out-of-range createdAt falls back to the store mtime instead of throwing', () => {
  // The descriptor is hex-encoded JSON inside a SQLite row: a truncated or
  // newer-Cursor write can put any number there. `new Date(1e20).toISOString()`
  // throws RangeError, and a thrown unit aborts a strict (force) rebuild.
  const root = makeTempDir('obelisk-cursor-time-');
  writeStore(root, { sessionId: 'sid-time', descriptor: { createdAt: 1e20 } });
  const provider = createCursorProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));

  const session = values.find((record) => record.kind === 'session');
  assert.ok(session, 'the session is still projected');
  assert.equal(Number.isFinite(Date.parse(session.started_at)), true);
  assert.equal(Number.isFinite(Date.parse(session.ended_at)), true);
  for (const record of values) {
    if (record.kind !== 'message') continue;
    assert.equal(Number.isFinite(Date.parse(record.timestamp)), true, `timestamp of ${record.uuid}`);
  }
});
