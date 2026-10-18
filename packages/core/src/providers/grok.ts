// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

// Grok CLI provider adapter.
//
// On-disk layout (one directory per session):
//   ~/.grok/sessions/<url-encoded-cwd>/<session-id>/
//     summary.json        session metadata: id, cwd, title, span, model, git branch
//     chat_history.jsonl  the transcript: system | user | reasoning | assistant | tool_result
//     events.jsonl        lifecycle telemetry (turn_started, tool_started, phase_changed)
//     updates.jsonl       ACP session/update stream (huge; not read here)
//     rewind_points.jsonl checkpoints; a rewind may truncate chat_history
//
// chat_history.jsonl is a flat, ordered list of chat events rather than a
// message tree: assistant rows carry `tool_calls`, and a following `tool_result`
// row points back at one of those call ids. There is no per-message timestamp,
// so this adapter spreads messages across the session's own
// [created_at, updated_at] span. Ordering stays stable and every timestamp sits
// inside a span Grok itself recorded; we do not invent precision beyond that.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize } from 'node:path';

import {
  filePath, isDir, projectSlugFromPath, readLines, sourceInventoryIssue, trunc, truncJson,
} from '../parsing.ts';

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

export const name = 'grok';
export const GROK_CANONICAL_TRANSCRIPT_MARKER = '__grok_canonical_transcript_v1__';

interface GrokSummary {
  info?: { id?: string; cwd?: string };
  session_summary?: string | null;
  generated_title?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  last_active_at?: string | null;
  num_chat_messages?: number | null;
  current_model_id?: string | null;
  session_kind?: string | null;
  git_root_dir?: string | null;
  head_branch?: string | null;
  agent_name?: string | null;
}

interface GrokUnitMeta {
  readonly summaryPath: string;
  readonly transcriptPath: string;
  readonly summary: GrokSummary | null;
  readonly previousSize: number | null;
}

// `<chat mtime>:<chat size>:<summary mtime>`. Size participates because a
// rewind truncates the transcript in place: without it a shorter file with a
// fresh mtime would look like an ordinary append.
function encodeCursor(transcriptPath: string, summaryPath: string): string {
  const chat = statSync(transcriptPath);
  const summaryMtime = existsSync(summaryPath) ? statSync(summaryPath).mtimeMs : 0;
  return `${chat.mtimeMs}:${chat.size}:${summaryMtime}`;
}

function previousSize(cursor: Cursor): number | null {
  if (!cursor) return null;
  const size = Number(cursor.split(':')[1]);
  return Number.isFinite(size) ? size : null;
}

function readSummary(path: string): GrokSummary | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed as GrokSummary : null;
  } catch {
    return null;
  }
}

// The first path component is the URL-encoded working directory. It is the only
// project signal available when summary.json is missing or unreadable.
function decodedProjectDir(encoded: string): string | null {
  try {
    const decoded = decodeURIComponent(encoded);
    return isAbsolute(decoded) ? normalize(decoded) : null;
  } catch {
    return null;
  }
}

function sessionCwd(summary: GrokSummary | null, encodedDir: string): string | null {
  const cwd = summary?.info?.cwd;
  if (typeof cwd === 'string' && isAbsolute(cwd)) return normalize(cwd);
  return decodedProjectDir(encodedDir);
}

function sessionTitle(summary: GrokSummary | null, sessionId: string): string | null {
  const title = summary?.generated_title || summary?.session_summary;
  if (typeof title === 'string' && title.trim()) return title.trim();
  return sessionId;
}

function discoverAt(rootDir: string, ctx: DiscoverContext): IndexUnit[] {
  const units: IndexUnit[] = [];
  if (!existsSync(rootDir)) {
    if ((ctx.indexedSessions?.().length ?? 0) > 0) {
      ctx.reportIncompleteInventory?.({ path: rootDir, error: 'Source folder is unavailable' });
    }
    return units;
  }
  let projects: string[];
  try {
    projects = readdirSync(rootDir);
  } catch (error) {
    ctx.reportIncompleteInventory?.(sourceInventoryIssue(rootDir, error));
    return units;
  }
  const changed = ctx.changedPaths === undefined
    ? null
    : new Set(ctx.changedPaths.map((p) => normalize(isAbsolute(p) ? p : join(rootDir, p))));
  for (const projectDir of projects) {
    const projectPath = join(rootDir, projectDir);
    if (!isDir(projectPath)) continue;
    let sessions: string[];
    try {
      sessions = readdirSync(projectPath);
    } catch (error) {
      ctx.reportIncompleteInventory?.(sourceInventoryIssue(projectPath, error));
      continue;
    }
    for (const sessionDirName of sessions) {
      const sessionDir = join(projectPath, sessionDirName);
      if (!isDir(sessionDir)) continue;
      const transcriptPath = join(sessionDir, 'chat_history.jsonl');
      if (!existsSync(transcriptPath)) continue;
      const summaryPath = join(sessionDir, 'summary.json');
      const normalizedTranscript = normalize(transcriptPath);
      if (changed !== null && !changed.has(normalizedTranscript)) continue;
      const summary = readSummary(summaryPath);
      const sessionId = typeof summary?.info?.id === 'string' && summary.info.id
        ? summary.info.id
        : sessionDirName;
      const cursor = ctx.lastCursor(transcriptPath);
      let signature: string;
      try {
        signature = encodeCursor(transcriptPath, summaryPath);
      } catch (error) {
        ctx.reportIncompleteInventory?.(sourceInventoryIssue(transcriptPath, error));
        continue;
      }
      if (cursor !== null && cursor === signature) continue;
      const prior = previousSize(cursor);
      const current = statSync(transcriptPath).size;
      // A rewind truncates the transcript in place. Rows the previous snapshot
      // wrote for this session no longer exist in the source, so retract before
      // reprojecting instead of leaving orphaned messages behind.
      const rewound = prior !== null && current < prior;
      units.push({
        key: normalizedTranscript,
        sessionId,
        project: projectSlugFromPath(sessionCwd(summary, projectDir)) ?? undefined,
        ...(rewound ? { retractSessionIds: [sessionId] } : {}),
        meta: {
          summaryPath,
          transcriptPath: normalizedTranscript,
          summary,
          previousSize: prior,
        } satisfies GrokUnitMeta,
      });
    }
  }
  return units;
}

function contentText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === 'string') parts.push(part);
    else if (typeof part?.text === 'string') parts.push(part.text);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function reasoningText(summary: unknown): string | null {
  if (!Array.isArray(summary)) return null;
  const parts = summary
    .map((item: any) => (typeof item?.text === 'string' ? item.text : null))
    .filter((text): text is string => text !== null);
  return parts.length > 0 ? parts.join('\n') : null;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

// Tool ids are provider-facing and reused across sessions in the same way
// message ids are, so they are namespaced too. Call and result must agree.
function grokToolId(sessionId: string, callId: string): string {
  return `grok-${sessionId}-tc-${callId}`;
}

/**
 * Session-scoped message id, stable across replays.
 *
 * Provider ids are unique per conversation at best. Reasoning rows reuse the
 * same `rs_…` id when Grok retries a turn, and `messages` is keyed by uuid
 * alone, so a plain `grok-<sid>-<id>` would overwrite the earlier copy and leave
 * a row whose `parent_uuid` points at itself — a context walk on it never
 * terminates. Repeats get a `-2`, `-3`, … suffix. Both parse and raw scan the
 * file in the same order, so the suffix is reproducible without storing it.
 */
function sessionUuid(
  sessionId: string,
  rawId: unknown,
  rowIndex: number,
  seen: Map<string, number>,
): string {
  const base = `grok-${sessionId}-${typeof rawId === 'string' && rawId ? rawId : rowIndex}`;
  const occurrence = (seen.get(base) ?? 0) + 1;
  seen.set(base, occurrence);
  return occurrence === 1 ? base : `${base}-${occurrence}`;
}

interface GrokEvent {
  type: string;
  content?: unknown;
  summary?: unknown;
  tool_calls?: Array<{ id?: string; name?: string; arguments?: string }>;
  tool_call_id?: string;
  id?: string;
  model_id?: string;
  reasoning_effort?: string;
}

export function* parse(unit: IndexUnit, _cursor: Cursor): Generator<TranscriptRecord, Cursor> {
  const meta = unit.meta as GrokUnitMeta | undefined;
  const transcriptPath = meta?.transcriptPath ?? unit.key;
  const summaryPath = meta?.summaryPath ?? join(dirname(unit.key), 'summary.json');
  const summary = meta?.summary ?? readSummary(summaryPath);
  const sid = unit.sessionId;

  const events: GrokEvent[] = [];
  readLines(transcriptPath, (line: string) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.type === 'string') {
        events.push(parsed as GrokEvent);
      }
    } catch { /* malformed transcript line */ }
  });

  const startedAt = isoOrNull(summary?.created_at) ?? isoOrNull(summary?.updated_at);
  const endedAt = isoOrNull(summary?.updated_at) ?? startedAt;
  const startMs = startedAt === null ? null : Date.parse(startedAt);
  const endMs = endedAt === null ? null : Date.parse(endedAt);
  // Spread messages across the recorded span: monotonic, inside the source's
  // own frame, and identical on replay (so incremental parses stay stable).
  const timestampAt = (index: number): string | null => {
    if (startMs === null) return null;
    if (endMs === null || endMs <= startMs || events.length <= 1) return new Date(startMs).toISOString();
    const ratio = index / (events.length - 1);
    return new Date(Math.round(startMs + (endMs - startMs) * ratio)).toISOString();
  };

  const isSubagent = summary?.session_kind === 'subagent' || summary?.session_kind === 'subagent_resume';
  const model = typeof summary?.current_model_id === 'string' ? summary.current_model_id : null;
  const agentName = typeof summary?.agent_name === 'string' ? summary.agent_name : null;
  const titleBase = sessionTitle(summary, sid);
  const title = isSubagent && titleBase !== null
    ? `[${agentName ?? 'subagent'}] ${titleBase}`
    : titleBase;

  let messageCount = 0;
  let lastUuid: string | null = null;
  const toolCallOwners = new Map<string, string>();
  const seenUuids = new Map<string, number>();

  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    const timestamp = timestampAt(index);
    // Provider ids are only unique inside a session: reasoning rows reuse
    // `rs_…` ids across conversations, and the messages table is keyed by uuid
    // alone, so an unprefixed id would overwrite a sibling session's row.
    const uuid = sessionUuid(sid, event.id, index, seenUuids);

    if (event.type === 'system') {
      const text = contentText(event.content);
      if (text === null) continue;
      // Grok persists its system prompt as the first row. Keep it for search
      // but hide it from the conversation view, matching how other adapters
      // treat provider-injected meta content.
      yield {
        kind: 'message', uuid, session_id: sid, type: 'system',
        parent_uuid: lastUuid, timestamp, role: 'system',
        text: trunc(text), content_type: 'text', is_meta: 1,
        visibility: 'hidden' as MessageVisibility, model: null, is_sidechain: 0, agent_id: null,
        input_tokens: null, output_tokens: null, cwd: null, skill: null, source: name,
      };
      lastUuid = uuid;
      continue;
    }

    if (event.type === 'user') {
      const text = contentText(event.content);
      if (text === null) continue;
      messageCount++;
      yield {
        kind: 'message', uuid, session_id: sid, type: 'user',
        parent_uuid: lastUuid, timestamp, role: 'user',
        text: trunc(text), content_type: 'text', is_meta: 0,
        visibility: 'visible' as MessageVisibility, model: null, is_sidechain: 0, agent_id: null,
        input_tokens: null, output_tokens: null, cwd: null, skill: null, source: name,
      };
      lastUuid = uuid;
      continue;
    }

    if (event.type === 'reasoning') {
      const text = reasoningText(event.summary);
      if (text === null) continue;
      messageCount++;
      yield {
        kind: 'message', uuid, session_id: sid, type: 'reasoning',
        parent_uuid: lastUuid, timestamp, role: 'assistant',
        text: trunc(text), content_type: 'thinking', is_meta: 0,
        visibility: 'visible' as MessageVisibility, model, is_sidechain: 0, agent_id: null,
        input_tokens: null, output_tokens: null, cwd: null, skill: null, source: name,
      };
      lastUuid = uuid;
      continue;
    }

    if (event.type === 'assistant') {
      const text = contentText(event.content);
      const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
      // A tool-only assistant turn still needs a message row to own its tool
      // calls, or the call would point at a uuid that does not exist.
      if (text !== null || calls.length > 0) {
        messageCount++;
        yield {
          kind: 'message', uuid, session_id: sid, type: 'assistant',
          parent_uuid: lastUuid, timestamp, role: 'assistant',
          text: text === null ? null : trunc(text), content_type: 'text', is_meta: 0,
          visibility: 'visible' as MessageVisibility,
          model: typeof event.model_id === 'string' ? event.model_id : model,
          is_sidechain: 0, agent_id: isSubagent ? (agentName ?? null) : null,
          input_tokens: null, output_tokens: null, cwd: null, skill: null, source: name,
        };
        lastUuid = uuid;
      }
      for (const call of calls) {
        if (typeof call?.id !== 'string' || !call.id) continue;
        toolCallOwners.set(grokToolId(sid, call.id), uuid);
        let parsedInput: any;
        try {
          parsedInput = call.arguments === undefined ? {} : JSON.parse(call.arguments);
        } catch {
          parsedInput = { raw: trunc(String(call.arguments ?? '')) };
        }
        yield {
          kind: 'tool_call', id: grokToolId(sid, call.id), message_uuid: uuid, session_id: sid,
          name: typeof call.name === 'string' ? call.name : '',
          presentation: call.name === 'Skill' ? 'skill' : 'default',
          input_json: truncJson(parsedInput as any) as string,
          file_path: filePath(call.name ?? '', parsedInput && typeof parsedInput === 'object' ? parsedInput as any : {}),
        };
      }
      continue;
    }

    if (event.type === 'backend_tool_call') {
      // Server-side tools (web_search, …) are recorded without a call id and
      // never produce a tool_result row; keep them as searchable provenance.
      const kind = (event as { kind?: { tool_type?: string; action?: unknown } }).kind;
      const toolType = typeof kind?.tool_type === 'string' ? kind.tool_type : 'backend_tool';
      yield {
        kind: 'tool_call', id: `grok-bt-${sid}-${index}`,
        message_uuid: lastUuid ?? uuid, session_id: sid,
        name: toolType, presentation: 'default',
        input_json: truncJson((kind?.action ?? {}) as any) as string,
        file_path: null,
      };
      continue;
    }

    if (event.type === 'tool_result') {
      const callId = typeof event.tool_call_id === 'string' ? event.tool_call_id : null;
      if (callId === null) continue;
      const text = contentText(event.content);
      yield {
        kind: 'tool_result', tool_use_id: grokToolId(sid, callId),
        message_uuid: toolCallOwners.get(grokToolId(sid, callId)) ?? lastUuid ?? grokToolId(sid, callId),
        session_id: sid,
        content: trunc(text ?? ''),
        file_path: null,
        is_error: typeof text === 'string' && /^(?:error|Error|ERROR)\b/.test(text) ? 1 : 0,
      };
    }
  }

  yield {
    kind: 'session', id: sid, title, project: unit.project ?? null,
    started_at: startedAt, ended_at: endedAt,
    git_branch: typeof summary?.head_branch === 'string' ? summary.head_branch : null,
    version: null, message_count: messageCount,
    countMode: 'total',
    jsonl_path: transcriptPath, source: name,
  };

  return encodeCursor(transcriptPath, summaryPath);
}

function rawGrok(input: RawLookup): RawRecord | null {
  const transcriptPath = typeof input.session?.jsonl_path === 'string' ? input.session.jsonl_path : null;
  if (transcriptPath === null || !existsSync(transcriptPath)) return null;
  const sid = typeof input.session?.id === 'string' ? input.session.id : '';
  let found: string | null = null;
  let index = 0;
  const seen = new Map<string, number>();
  readLines(transcriptPath, (line: string) => {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; /* malformed transcript line */
    }
    // parse() ignores rows that are not typed objects and numbers the rest from
    // zero, so raw has to skip them too — otherwise every malformed line shifts
    // the derived ids by one and a lookup silently returns a neighbouring row.
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.type !== 'string') return;
    const rowIndex = index++;
    // Recompute the row's id with the same rule parse() used, including the
    // session namespace and the duplicate suffix, so a lookup cannot land on a
    // sibling session's row.
    const uuid = sessionUuid(sid, parsed.id, rowIndex, seen);
    const callIds: string[] = Array.isArray(parsed?.tool_calls)
      ? parsed.tool_calls
        .map((call: any) => (typeof call?.id === 'string' ? grokToolId(sid, call.id) : null))
        .filter((id: string | null): id is string => id !== null)
      : [];
    const resultId = typeof parsed?.tool_call_id === 'string' ? grokToolId(sid, parsed.tool_call_id) : null;
    const backendId = parsed?.type === 'backend_tool_call' ? `grok-bt-${sid}-${rowIndex}` : null;
    if (
      input.messageUuid === uuid
      || input.messageUuid === resultId
      || input.messageUuid === backendId
      || callIds.includes(input.messageUuid)
    ) {
      found = line;
      return false;
    }
  });
  const raw = found as string | null;
  if (raw === null) return null;
  let messageText: string | null = null;
  try {
    const parsed = JSON.parse(raw);
    messageText = contentText(parsed?.content) ?? reasoningText(parsed?.summary);
  } catch { /* malformed transcript line */ }
  return { text: raw, totalLength: raw.length, offset: 0, limit: raw.length, hasMore: false, messageText };
}

export function createGrokProvider({
  rootDir,
  homeDir = homedir(),
}: {
  rootDir?: string;
  homeDir?: string;
} = {}): ProviderAdapter {
  const resolvedRoot = rootDir !== undefined && rootDir.trim() !== ''
    ? (rootDir.startsWith('~/') ? join(homeDir, rootDir.slice(2)) : rootDir)
    : join(homeDir, '.grok', 'sessions');
  return {
    name,
    descriptor: { id: name, name: 'Grok CLI', vendor: 'xAI', defaultRoot: resolvedRoot, color: '#1f2937' },
    indexVersionMarker: GROK_CANONICAL_TRANSCRIPT_MARKER,
    watchTargets: (configuredRoot) => [{ kind: 'tree', path: configuredRoot }],
    discover: (ctx) => discoverAt(resolvedRoot, ctx),
    parse,
    raw: rawGrok,
  };
}

export const grokProvider = createGrokProvider();
