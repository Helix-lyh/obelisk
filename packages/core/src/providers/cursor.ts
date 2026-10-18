// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Cursor provider adapter.
//
// Cursor does not keep a transcript log. Every conversation is its own SQLite
// store with two tables:
//
//   meta(key, value)   row key='0' holds a HEX-encoded JSON descriptor:
//                      {agentId, latestRootBlobId, name, createdAt, subagentInfo,
//                       blobEncryptionKey}
//   blobs(id, data)    a content-addressed DAG. An internal node is a protobuf
//                      message whose repeated field 1 is the 32-byte id of a
//                      child blob; leaves are UTF-8 JSON messages of the shape
//                      {role, content, id?, providerOptions?}.
//
// Two on-disk families share that format:
//   ~/.cursor/chats/<workspace-hash>/<session-id>/store.db   (IDE / agent)
//   ~/.cursor/acp-sessions/<session-id>/store.db             (ACP), with meta.json
//
// `blobEncryptionKey` exists in the descriptor, and some builds do write
// encrypted leaves. This adapter walks the DAG and projects only leaves that
// decode as JSON; opaque leaves are counted and skipped rather than guessed at.
// A store whose whole graph is opaque still yields a session row, so the gap is
// visible instead of silently missing.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { isDir, normalizeObservedCwd, projectSlugFromPath, trunc, truncJson } from '../parsing.ts';

import type { SqliteDb } from '../sqlite-types.ts';
import type {
  Cursor,
  DiscoverContext,
  IndexUnit,
  MessageVisibility,
  ProviderAdapter,
  RawLookup,
  RawRecord,
  TranscriptRecord,
} from './types.ts';

export const name = 'cursor';
export const CURSOR_CANONICAL_TRANSCRIPT_MARKER = '__cursor_canonical_transcript_v1__';

const BUSY_TIMEOUT_MS = 2_000;

// This module is emitted as ESM, where a bare `require` does not exist.
const require = createRequire(import.meta.url);

export type CursorDatabaseOpener = (dbPath: string) => SqliteDb;

export interface CursorRoots {
  readonly chats: string;
  readonly acpSessions: string;
}

interface CursorUnitMeta {
  readonly storePath: string;
  readonly kind: 'chat' | 'acp';
  readonly sessionDir: string;
}

interface CursorDescriptor {
  agentId?: string;
  latestRootBlobId?: string;
  name?: string;
  createdAt?: number;
  subagentInfo?: { typeName?: string; parentAgentId?: string };
  blobEncryptionKey?: string;
}

interface CursorContentBlock {
  type?: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
}

interface CursorMessage {
  role?: string;
  content?: string | CursorContentBlock[];
  id?: string;
  providerOptions?: { cursor?: { systemPromptFingerprint?: { model?: string } } };
}

function defaultOpenSource(dbPath: string): SqliteDb {
  // Keep the Node-only binding out of the Electron bundle (same reason as
  // zcode): Rollup hoists even a literal require('node:sqlite').
  const nodeSqliteSpecifier = ['node', 'sqlite'].join(':');
  const { DatabaseSync } = require(nodeSqliteSpecifier) as {
    DatabaseSync: new (path: string, options: { readOnly: boolean; timeout: number }) => SqliteDb;
  };
  return new DatabaseSync(dbPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
}

function openSource(dbPath: string, opener: CursorDatabaseOpener): SqliteDb | null {
  try {
    return opener(dbPath);
  } catch {
    return null;
  }
}

function storeTables(db: SqliteDb): Set<string> {
  try {
    return new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        .map((row) => String((row as { name: unknown }).name)),
    );
  } catch {
    return new Set();
  }
}

function descriptorOf(db: SqliteDb): CursorDescriptor | null {
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('0') as { value?: unknown } | undefined;
    if (typeof row?.value !== 'string') return null;
    // The value is hex text, not JSON.
    const decoded = Buffer.from(row.value, 'hex').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed !== null && typeof parsed === 'object' ? parsed as CursorDescriptor : null;
  } catch {
    return null;
  }
}

function acpMetadata(sessionDir: string): { cwd?: string; title?: string } {
  const path = join(sessionDir, 'meta.json');
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return {};
    const cwd = typeof parsed.cwd === 'string' ? parsed.cwd : undefined;
    let title: string | undefined;
    if (typeof parsed.title === 'string') {
      try {
        const nested = JSON.parse(parsed.title);
        title = typeof nested?.title === 'string' ? nested.title : parsed.title;
      } catch {
        title = parsed.title;
      }
    }
    return { cwd, title };
  } catch {
    return {};
  }
}

// `<db mtime>:<db size>:<wal mtime>`: WAL writes can land without touching the
// main file's size, so the -wal timestamp participates too.
function encodeCursor(storePath: string): string {
  const db = statSync(storePath);
  const walPath = `${storePath}-wal`;
  const walMtime = existsSync(walPath) ? statSync(walPath).mtimeMs : 0;
  return `${db.mtimeMs}:${db.size}:${walMtime}`;
}

function discoverAt(roots: CursorRoots, ctx: DiscoverContext): IndexUnit[] {
  const units: IndexUnit[] = [];
  const changed = ctx.changedPaths === undefined
    ? null
    : new Set(ctx.changedPaths.map((path) => path.endsWith('store.db') ? path : join(path, 'store.db')));

  const addStore = (storePath: string, kind: 'chat' | 'acp', sessionDir: string, sessionId: string) => {
    if (!existsSync(storePath)) return;
    if (changed !== null && !changed.has(storePath)) return;
    let signature: string;
    try {
      signature = encodeCursor(storePath);
    } catch {
      return;
    }
    const cursor = ctx.lastCursor(storePath);
    if (cursor !== null && cursor === signature) return;
    const acp = kind === 'acp' ? acpMetadata(sessionDir) : {};
    units.push({
      key: storePath,
      sessionId,
      project: projectSlugFromPath(normalizeObservedCwd(acp.cwd)) ?? undefined,
      meta: { storePath, kind, sessionDir } satisfies CursorUnitMeta,
    });
  };

  const chatsRoot = roots.chats;
  if (existsSync(chatsRoot)) {
    let buckets: string[] = [];
    try {
      buckets = readdirSync(chatsRoot);
    } catch (error) {
      ctx.reportIncompleteInventory?.({ path: chatsRoot, error: String((error as Error)?.message ?? error) });
    }
    for (const bucket of buckets) {
      const bucketPath = join(chatsRoot, bucket);
      if (!isDir(bucketPath)) continue;
      let sessions: string[];
      try {
        sessions = readdirSync(bucketPath);
      } catch {
        continue;
      }
      for (const sessionId of sessions) {
        const sessionDir = join(bucketPath, sessionId);
        if (!isDir(sessionDir)) continue;
        addStore(join(sessionDir, 'store.db'), 'chat', sessionDir, sessionId);
      }
    }
  }

  const acpRoot = roots.acpSessions;
  if (existsSync(acpRoot)) {
    let sessions: string[] = [];
    try {
      sessions = readdirSync(acpRoot);
    } catch (error) {
      ctx.reportIncompleteInventory?.({ path: acpRoot, error: String((error as Error)?.message ?? error) });
    }
    for (const sessionId of sessions) {
      const sessionDir = join(acpRoot, sessionId);
      if (!isDir(sessionDir)) continue;
      // Namespaced so an ACP session can never collide with a chat store id.
      addStore(join(sessionDir, 'store.db'), 'acp', sessionDir, `acp-${sessionId}`);
    }
  }

  return units;
}

interface ProtobufRef {
  readonly field: number;
  readonly bytes: Buffer;
}

// Minimal protobuf walk: enough to read the repeated `bytes` field that links
// one blob to the next. Unknown wire types stop the parse rather than guess.
function protobufRefs(buf: Buffer): ProtobufRef[] {
  const refs: ProtobufRef[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const tag = buf[offset++]!;
    const field = tag >> 3;
    const wire = tag & 0x07;
    if (wire === 0) {
      while (offset < buf.length && (buf[offset++]! & 0x80) !== 0) { /* varint */ }
    } else if (wire === 1) {
      offset += 8;
    } else if (wire === 2) {
      let length = 0;
      let shift = 0;
      while (offset < buf.length) {
        const byte = buf[offset++]!;
        length |= (byte & 0x7f) << shift;
        if ((byte & 0x80) === 0) break;
        shift += 7;
      }
      if (length < 0 || offset + length > buf.length) break;
      refs.push({ field, bytes: buf.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 5) {
      offset += 4;
    } else {
      break;
    }
  }
  return refs;
}

interface WalkedStore {
  readonly messages: CursorMessage[];
  readonly opaqueBlobs: number;
}

// Depth-first, children pushed in reverse so the traversal order matches the
// order the graph records them: newest message chain first, oldest last.
function walkStore(db: SqliteDb, rootId: string): WalkedStore {
  const messages: CursorMessage[] = [];
  let opaqueBlobs = 0;
  let select: ReturnType<SqliteDb['prepare']>;
  try {
    select = db.prepare('SELECT data FROM blobs WHERE id = ?');
  } catch {
    return { messages, opaqueBlobs: 1 };
  }
  const seen = new Set<string>();
  const stack = [rootId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    let row: { data?: unknown } | undefined;
    try {
      row = select.get(id) as { data?: unknown } | undefined;
    } catch {
      continue;
    }
    if (row?.data === undefined || row.data === null) continue;
    const buf = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data as ArrayBuffer);
    if (buf[0] === 0x7b) {
      try {
        const parsed = JSON.parse(buf.toString('utf8'));
        if (parsed !== null && typeof parsed === 'object') messages.push(parsed as CursorMessage);
      } catch {
        opaqueBlobs++;
      }
      continue;
    }
    const children = protobufRefs(buf)
      .filter((ref) => ref.field === 1 && ref.bytes.length === 32)
      .map((ref) => ref.bytes.toString('hex'));
    if (children.length === 0) {
      opaqueBlobs++;
      continue;
    }
    for (let index = children.length - 1; index >= 0; index--) stack.push(children[index]!);
  }
  return { messages, opaqueBlobs };
}

function blockText(content: string | CursorContentBlock[] | undefined): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function workspaceFromUserInfo(text: string | null): string | null {
  if (text === null) return null;
  const match = /Workspace Path:\s*(.+)/.exec(text);
  return match === null ? null : normalizeObservedCwd(match[1]!.trim());
}

function toolResultText(block: CursorContentBlock): string {
  if (typeof block.result === 'string') return block.result;
  if (block.result !== undefined && block.result !== null) return JSON.stringify(block.result);
  return '';
}

function firstLine(text: string, limit = 80): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? '';
  return line.length > limit ? `${line.slice(0, limit)}…` : line;
}

export function* parse(
  unit: IndexUnit,
  _cursor: Cursor,
  openDatabase: CursorDatabaseOpener = defaultOpenSource,
): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as CursorUnitMeta | undefined;
  const storePath = meta?.storePath ?? unit.key;
  const kind = meta?.kind ?? 'chat';
  const sessionDir = meta?.sessionDir ?? join(storePath, '..');
  const sid = unit.sessionId;

  const db = openSource(storePath, openDatabase);
  let descriptor: CursorDescriptor | null = null;
  let messages: CursorMessage[] = [];
  let opaqueBlobs = 0;
  if (db !== null) {
    try {
      const tables = storeTables(db);
      if (tables.has('meta') && tables.has('blobs')) {
        descriptor = descriptorOf(db);
        if (typeof descriptor?.latestRootBlobId === 'string') {
          const walked = walkStore(db, descriptor.latestRootBlobId);
          messages = walked.messages;
          opaqueBlobs = walked.opaqueBlobs;
        }
      }
    } finally {
      db.close();
    }
  }

  const acp = kind === 'acp' ? acpMetadata(sessionDir) : {};
  const baseMs = typeof descriptor?.createdAt === 'number' && Number.isFinite(descriptor.createdAt)
    ? descriptor.createdAt
    : statSync(storePath).mtimeMs;
  const endedAt = new Date(statSync(storePath).mtimeMs).toISOString();
  // Cursor records only a session creation time. Per-message timestamps are
  // assigned as creation + ordinal so ordering is monotonic and every value
  // stays inside the session's own span; the adapter does not pretend to know
  // minute-level timing it never wrote down.
  let ordinal = 0;
  const nextTimestamp = (): string => new Date(baseMs + ordinal++).toISOString();

  let projectPath = normalizeObservedCwd(acp.cwd);
  let title = typeof acp.title === 'string' && acp.title.trim() ? acp.title.trim() : null;
  let model: string | null = null;
  let messageCount = 0;
  let lastUuid: string | null = null;

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    const uuid = typeof message.id === 'string' && message.id.length > 12
      ? `cursor-${sid}-${message.id}`
      : `cursor-${sid}-${index}`;
    const role = typeof message.role === 'string' ? message.role : 'unknown';

    if (role === 'system') {
      const text = blockText(message.content);
      if (text === null) continue;
      yield {
        kind: 'message', uuid, session_id: sid, type: 'system',
        parent_uuid: lastUuid, timestamp: nextTimestamp(), role: 'system',
        text: trunc(text), content_type: 'text', is_meta: 1,
        visibility: 'hidden' as MessageVisibility, model: null, is_sidechain: 0, agent_id: null,
        input_tokens: null, output_tokens: null, cwd: null, skill: null, source: name,
      };
      lastUuid = uuid;
      continue;
    }

    if (role === 'user') {
      const text = blockText(message.content);
      if (text === null) continue;
      if (projectPath === null) projectPath = workspaceFromUserInfo(text);
      messageCount++;
      yield {
        kind: 'message', uuid, session_id: sid, type: 'user',
        parent_uuid: lastUuid, timestamp: nextTimestamp(), role: 'user',
        text: trunc(text), content_type: 'text', is_meta: 0,
        visibility: 'visible' as MessageVisibility, model: null, is_sidechain: 0, agent_id: null,
        input_tokens: null, output_tokens: null, cwd: null, skill: null, source: name,
      };
      lastUuid = uuid;
      continue;
    }

    if (role === 'assistant') {
      const text = blockText(message.content);
      const blocks = Array.isArray(message.content) ? message.content : [];
      const fingerprint = message.providerOptions?.cursor?.systemPromptFingerprint;
      if (model === null && typeof fingerprint?.model === 'string') model = fingerprint.model;
      const hasToolCall = blocks.some((block) => block?.type === 'tool-call');
      // Tool calls need a message row to hang from even when the turn carried
      // no prose.
      if (text !== null || hasToolCall) {
        messageCount++;
        yield {
          kind: 'message', uuid, session_id: sid, type: 'assistant',
          parent_uuid: lastUuid, timestamp: nextTimestamp(), role: 'assistant',
          text: text === null ? null : trunc(text), content_type: 'text', is_meta: 0,
          visibility: 'visible' as MessageVisibility, model, is_sidechain: 0, agent_id: null,
          input_tokens: null, output_tokens: null, cwd: null, skill: null, source: name,
        };
        lastUuid = uuid;
      }
      for (const block of blocks) {
        if (block?.type !== 'tool-call' || typeof block.toolCallId !== 'string') continue;
        yield {
          kind: 'tool_call', id: block.toolCallId, message_uuid: uuid, session_id: sid,
          name: typeof block.toolName === 'string' ? block.toolName : '',
          presentation: block.toolName === 'Skill' ? 'skill' : 'default',
          input_json: truncJson(block.args ?? {}) as string,
          file_path: null,
        };
      }
      continue;
    }

    if (role === 'tool') {
      const blocks = Array.isArray(message.content) ? message.content : [];
      for (const block of blocks) {
        if (block?.type !== 'tool-result' || typeof block.toolCallId !== 'string') continue;
        const output = toolResultText(block);
        yield {
          kind: 'tool_result', tool_use_id: block.toolCallId,
          message_uuid: lastUuid ?? uuid, session_id: sid,
          content: trunc(output),
          file_path: null,
          is_error: block.isError === true || (block as any)?.providerOptions?.cursor
            ?.highLevelToolCallResult?.isError === true ? 1 : 0,
        };
      }
      continue;
    }
  }

  if (title === null) {
    const fromDescriptor = typeof descriptor?.name === 'string' ? descriptor.name.trim() : '';
    title = fromDescriptor && fromDescriptor !== 'New Agent' ? fromDescriptor : null;
  }
  if (title === null) {
    const firstUser = messages.find((message) => message.role === 'user');
    const firstText = blockText(firstUser?.content);
    title = firstText === null ? sid : firstLine(firstText);
  }
  const subagentType = descriptor?.subagentInfo?.typeName;
  if (typeof subagentType === 'string' && subagentType) title = `[${subagentType}] ${title}`;

  yield {
    kind: 'session', id: sid, title,
    project: projectSlugFromPath(projectPath) ?? unit.project ?? null,
    started_at: new Date(baseMs).toISOString(), ended_at: endedAt,
    git_branch: null, version: null,
    message_count: messageCount, countMode: 'total',
    jsonl_path: storePath, source: name,
  };

  if (opaqueBlobs > 0 && messages.length === 0) {
    // The whole graph is encrypted or unreadable: leave a trace without
    // pretending the session is empty.
    yield {
      kind: 'message', uuid: `cursor-${sid}-opaque`, session_id: sid, type: 'system',
      parent_uuid: null, timestamp: new Date(baseMs).toISOString(), role: 'system',
      text: `[cursor] ${opaqueBlobs} opaque blob(s); transcript could not be decoded`,
      content_type: 'notice', is_meta: 1,
      visibility: 'hidden' as MessageVisibility, model: null, is_sidechain: 0, agent_id: null,
      input_tokens: null, output_tokens: null, cwd: null, skill: null, source: name,
    };
  }

  return encodeCursor(storePath);
}

function rawCursor(input: RawLookup, openDatabase: CursorDatabaseOpener): RawRecord | null {
  const storePath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  if (storePath === null || !existsSync(storePath)) return null;
  const db = openSource(storePath, openDatabase);
  if (db === null) return null;
  try {
    const descriptor = descriptorOf(db);
    if (typeof descriptor?.latestRootBlobId !== 'string') return null;
    const walked = walkStore(db, descriptor.latestRootBlobId);
    for (const message of walked.messages) {
      const blocks = Array.isArray(message.content) ? message.content : [];
      const matchesBlock = blocks.some((block) => block?.toolCallId === input.messageUuid);
      const derivedMatch = input.messageUuid.startsWith(`cursor-`)
        && input.messageUuid.endsWith(`-${walked.messages.indexOf(message)}`);
      if (!matchesBlock && !derivedMatch) continue;
      const text = JSON.stringify(message);
      return {
        text, totalLength: text.length, offset: 0, limit: text.length, hasMore: false,
        messageText: blockText(message.content),
      };
    }
    return null;
  } finally {
    db.close();
  }
}

export function createCursorProvider({
  rootDir,
  homeDir = homedir(),
  openDatabase = defaultOpenSource,
}: {
  rootDir?: string;
  homeDir?: string;
  openDatabase?: CursorDatabaseOpener;
} = {}): ProviderAdapter {
  const resolvedRoot = rootDir !== undefined && rootDir.trim() !== ''
    ? (rootDir.startsWith('~/') ? join(homeDir, rootDir.slice(2)) : rootDir)
    : join(homeDir, '.cursor');
  const roots: CursorRoots = {
    chats: join(resolvedRoot, 'chats'),
    acpSessions: join(resolvedRoot, 'acp-sessions'),
  };
  return {
    name,
    descriptor: { id: name, name: 'Cursor', vendor: 'Anysphere', defaultRoot: resolvedRoot, color: '#0f172a' },
    indexVersionMarker: CURSOR_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot) => [
      { kind: 'tree', path: join(configuredRoot, 'chats') },
      { kind: 'tree', path: join(configuredRoot, 'acp-sessions') },
    ],
    discover: (ctx) => discoverAt(roots, ctx),
    parse: (unit, cursor) => parse(unit, cursor, openDatabase),
    raw: (input) => rawCursor(input, openDatabase),
  };
}

export const cursorProvider = createCursorProvider();
