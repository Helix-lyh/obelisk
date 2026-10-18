// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Grok adapter contract: directory discovery, transcript projection, tool
// call/result pairing, and the rewind retraction rule.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createGrokProvider } from '../packages/core/src/providers/grok.ts';
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

const EVENTS = [
  { type: 'system', content: 'You are Grok.' },
  { type: 'user', content: [{ type: 'text', text: 'why did the build break?' }] },
  { type: 'reasoning', id: 'rs-1', summary: [{ type: 'summary_text', text: 'check the log' }] },
  {
    type: 'assistant',
    content: 'Reading the build log.',
    model_id: 'grok-4.6',
    tool_calls: [{ id: 'call-1', name: 'read_file', arguments: '{"target_file":"/proj/app/build.log"}' }],
  },
  { type: 'tool_result', tool_call_id: 'call-1', content: 'error: module not found' },
  { type: 'assistant', content: 'The import path is wrong.' },
];

function writeSession(root, {
  project = '%2Fproj%2Fapp',
  sessionId = 'sid-1',
  summary = {},
  events = EVENTS,
} = {}) {
  const dir = join(root, project, sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'summary.json'), JSON.stringify({
    info: { id: sessionId, cwd: '/proj/app' },
    generated_title: 'Fix the build',
    created_at: '2026-08-01T10:00:00.000Z',
    updated_at: '2026-08-01T10:10:00.000Z',
    num_chat_messages: 4,
    current_model_id: 'grok-4.6',
    head_branch: 'main',
    ...summary,
  }));
  writeFileSync(
    join(dir, 'chat_history.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  return { dir, transcript: join(dir, 'chat_history.jsonl') };
}

test('grok: discovery walks <project>/<session> and keys the transcript file', () => {
  const root = makeTempDir('obelisk-grok-discover-');
  const { transcript } = writeSession(root);
  const provider = createGrokProvider({ rootDir: root });
  const units = provider.discover({ lastCursor: () => null });
  assert.equal(units.length, 1);
  assert.equal(units[0].key, transcript);
  assert.equal(units[0].sessionId, 'sid-1');
  assert.equal(units[0].project, '-proj-app');
});

test('grok: an unchanged cursor signature is skipped entirely', () => {
  const root = makeTempDir('obelisk-grok-skip-');
  const { transcript } = writeSession(root);
  const provider = createGrokProvider({ rootDir: root });
  const first = provider.discover({ lastCursor: () => null })[0];
  const { cursor } = drain(provider.parse(first, null));
  const again = provider.discover({ lastCursor: (key) => (key === transcript ? cursor : null) });
  assert.equal(again.length, 0);
});

test('grok: parse projects user/reasoning/assistant rows, pairs tools, and hides the system prompt', () => {
  const root = makeTempDir('obelisk-grok-parse-');
  const { transcript } = writeSession(root);
  const provider = createGrokProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values, cursor } = drain(provider.parse(unit, null));

  const sessions = values.filter((record) => record.kind === 'session');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, 'sid-1');
  assert.equal(sessions[0].title, 'Fix the build');
  assert.equal(sessions[0].project, '-proj-app');
  assert.equal(sessions[0].git_branch, 'main');
  assert.equal(sessions[0].message_count, 4);
  assert.equal(sessions[0].jsonl_path, transcript);
  assert.equal(sessions[0].source, 'grok');

  const system = values.find((record) => record.kind === 'message' && record.type === 'system');
  assert.equal(system.is_meta, 1);
  assert.equal(system.visibility, 'hidden');

  const messages = values.filter((record) => record.kind === 'message');
  assert.deepEqual(messages.map((record) => record.type), ['system', 'user', 'reasoning', 'assistant', 'assistant']);
  // Timestamps are interpolated across the recorded span, so they must be
  // monotonic and stay inside it.
  const stamps = messages.map((record) => Date.parse(record.timestamp));
  assert.deepEqual(stamps, [...stamps].sort((a, b) => a - b));
  assert.ok(stamps[0] >= Date.parse('2026-08-01T10:00:00.000Z'));
  assert.ok(stamps[stamps.length - 1] <= Date.parse('2026-08-01T10:10:00.000Z'));

  const calls = values.filter((record) => record.kind === 'tool_call');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'grok-sid-1-tc-call-1');
  assert.equal(calls[0].name, 'read_file');
  assert.match(calls[0].input_json, /build\.log/);

  const results = values.filter((record) => record.kind === 'tool_result');
  assert.equal(results.length, 1);
  assert.equal(results[0].tool_use_id, 'grok-sid-1-tc-call-1');
  assert.equal(results[0].message_uuid, calls[0].message_uuid);
  assert.match(results[0].content, /module not found/);

  assert.equal(typeof cursor, 'string');
  assert.equal(statSync(transcript).size > 0, true);
});

test('grok: a rewind (shorter transcript, newer mtime) retracts the session before reprojection', () => {
  const root = makeTempDir('obelisk-grok-rewind-');
  const { transcript } = writeSession(root);
  const provider = createGrokProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { cursor } = drain(provider.parse(unit, null));

  // Rewind drops the tail of the conversation.
  writeFileSync(transcript, EVENTS.slice(0, 2).map((event) => JSON.stringify(event)).join('\n') + '\n');
  const bumped = new Date(Date.now() + 5_000);
  utimesSync(transcript, bumped, bumped);

  const rewound = provider.discover({ lastCursor: (key) => (key === transcript ? cursor : null) });
  assert.equal(rewound.length, 1);
  assert.deepEqual(rewound[0].retractSessionIds, ['sid-1']);
});

test('grok: provider ids are namespaced per session so sibling sessions cannot overwrite each other', () => {
  const root = makeTempDir('obelisk-grok-namespace-');
  // Grok reuses `rs_…` reasoning ids across conversations; the messages table
  // is keyed by uuid alone, so the adapter must namespace them.
  const shared = { type: 'reasoning', id: 'rs_shared', summary: [{ type: 'summary_text', text: 'same id' }] };
  writeSession(root, { sessionId: 'sid-a', events: [EVENTS[1], shared] });
  writeSession(root, { sessionId: 'sid-b', events: [EVENTS[1], shared] });
  const provider = createGrokProvider({ rootDir: root });
  const uuids = new Set();
  for (const unit of provider.discover({ lastCursor: () => null })) {
    for (const record of drain(provider.parse(unit, null)).values) {
      if (record.kind === 'message' && record.type === 'reasoning') uuids.add(record.uuid);
    }
  }
  assert.equal(uuids.size, 2);
});

test('grok: the raw lookup resolves a namespaced message uuid back to its transcript line', () => {
  const root = makeTempDir('obelisk-grok-raw-');
  const { transcript } = writeSession(root);
  const provider = createGrokProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const reasoning = values.find((record) => record.kind === 'message' && record.type === 'reasoning');
  const session = values.find((record) => record.kind === 'session');
  const raw = provider.raw({
    source: 'grok',
    messageUuid: reasoning.uuid,
    session: { id: session.id, jsonl_path: transcript },
    agentId: null,
  });
  assert.ok(raw !== null);
  assert.match(raw.messageText, /check the log/);
});

test('grok: subagent sessions are indexed with an identifying title prefix', () => {
  const root = makeTempDir('obelisk-grok-subagent-');
  writeSession(root, {
    sessionId: 'sid-sub',
    summary: { session_kind: 'subagent', agent_name: 'general-purpose' },
  });
  const provider = createGrokProvider({ rootDir: root });
  const unit = provider.discover({ lastCursor: () => null })[0];
  const { values } = drain(provider.parse(unit, null));
  const session = values.find((record) => record.kind === 'session');
  assert.equal(session.title, '[general-purpose] Fix the build');
});
