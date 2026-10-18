// Copyright (C) 2026 tommy0103 and contributors.
// SPDX-License-Identifier: AGPL-3.0-only

import { homedir } from 'node:os';
import { join } from 'node:path';

import { createClaudeProvider } from './claude.ts';
import { createCodexProvider } from './codex.ts';
import { createCopilotProvider, type CopilotChronicleOpener } from './copilot.ts';
import { createCursorProvider, type CursorDatabaseOpener } from './cursor.ts';
import { createDeepseekProvider } from './deepseek.ts';
import { createGrokProvider } from './grok.ts';
import { createHermesProvider, type HermesStoreOpener } from './hermes.ts';
import { createKimiProvider } from './kimi.ts';
import { createKiroProvider, type KiroDatabaseOpener } from './kiro.ts';
import { createOmpProvider } from './omp.ts';
import { createPiProvider } from './pi.ts';
import { createZcodeProvider, type ZcodeDatabaseOpener } from './zcode.ts';
import { createProviderRegistry, type ProviderRegistry } from './registry.ts';

export type BuiltinProviderRoots = Readonly<Record<string, string | undefined>>;

export function createBuiltinProviderRegistry(
  roots: BuiltinProviderRoots = {},
  {
    cwd,
    copilotUserDataRoots,
    openCopilotChronicle,
    openCursorDatabase,
    openHermesStore,
    openZcodeDatabase,
    openKiroDatabase,
  }: {
    cwd?: string;
    copilotUserDataRoots?: readonly string[];
    openCopilotChronicle?: CopilotChronicleOpener;
    openCursorDatabase?: CursorDatabaseOpener;
    openHermesStore?: HermesStoreOpener;
    openZcodeDatabase?: ZcodeDatabaseOpener;
    openKiroDatabase?: KiroDatabaseOpener;
  } = {},
): ProviderRegistry {
  return createProviderRegistry([
    createClaudeProvider({ rootDir: roots['claude'] }),
    // Vendor forks of Claude Code: same transcript layout, separate source tag
    // so a row records which CLI wrote it and session ids cannot collide.
    createClaudeProvider({
      id: 'claude-alt',
      displayName: 'Claude Code (alt build)',
      vendor: 'Anthropic fork',
      color: '#c2603f',
      rootDir: roots['claude-alt'] ?? join(homedir(), '.claude-alt'),
    }),
    createClaudeProvider({
      id: 'claude-vendor',
      displayName: 'Claude Code (vendor fork)',
      vendor: 'Vendor fork',
      color: '#2f7d95',
      rootDir: roots['claude-vendor'] ?? join(homedir(), '.claude-vendor'),
    }),
    createClaudeProvider({
      id: 'claude-beta',
      displayName: 'Claude Code (beta)',
      vendor: 'Anthropic fork',
      color: '#8a6ea8',
      rootDir: roots['claude-beta'] ?? join(homedir(), '.claude-beta'),
    }),
    createCodexProvider({ rootDir: roots['codex'] }),
    createCopilotProvider({ rootDir: roots['copilot'], userDataRoots: copilotUserDataRoots, openChronicle: openCopilotChronicle }),
    createCursorProvider({ rootDir: roots['cursor'], openDatabase: openCursorDatabase }),
    createDeepseekProvider({ rootDir: roots['deepseek'] }),
    createGrokProvider({ rootDir: roots['grok'] }),
    createHermesProvider({ rootDir: roots['hermes'], openStore: openHermesStore }),
    createKimiProvider({ rootDir: roots['kimi'] }),
    createKiroProvider({ rootDir: roots['kiro'], openDatabase: openKiroDatabase }),
    createOmpProvider({ rootDir: roots['omp'] }),
    createPiProvider({ rootDir: roots['pi'], cwd }),
    createZcodeProvider({ rootDir: roots['zcode'], openDatabase: openZcodeDatabase }),
  ]);
}
