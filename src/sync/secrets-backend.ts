import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PluginInput } from '@opencode-ai/plugin';
import type { NormalizedSyncConfig } from './config.js';
import { chmodIfExists, pathExists } from './config.js';
import { SyncCommandError } from './errors.js';
import type { SyncLocations } from './paths.js';

type Shell = PluginInput['$'];

export interface OnePasswordConfig {
  vault: string;
  documents: {
    authJson: string;
    mcpAuthJson: string;
    envFile?: string;
  };
}

export interface SecretsBackend {
  pull: () => Promise<void>;
  push: () => Promise<void>;
  status: () => Promise<string>;
}

export type OnePasswordResolution =
  | { state: 'none' }
  | { state: 'invalid'; error: string }
  | { state: 'ok'; config: OnePasswordConfig };

export function resolveOnePasswordConfig(config: NormalizedSyncConfig): OnePasswordResolution {
  const backend = config.secretsBackend;
  if (!backend || backend.type !== '1password') {
    return { state: 'none' };
  }

  const vault = backend.vault?.trim();
  if (!vault) {
    return {
      state: 'invalid',
      error: 'secretsBackend.vault is required for type "1password".',
    };
  }

  const documents = backend.documents ?? {};
  const authJson = documents.authJson?.trim();
  const mcpAuthJson = documents.mcpAuthJson?.trim();

  if (!authJson || !mcpAuthJson) {
    return {
      state: 'invalid',
      error:
        'secretsBackend.documents.authJson and secretsBackend.documents.mcpAuthJson ' +
        'are required for type "1password".',
    };
  }

  return {
    state: 'ok',
    config: {
      vault,
      documents: {
        authJson,
        mcpAuthJson,
        envFile: documents.envFile,
      },
    },
  };
}

export function resolveAuthFilePaths(locations: SyncLocations): {
  authPath: string;
  mcpAuthPath: string;
} {
  const dataRoot = path.join(locations.xdg.dataDir, 'opencode');
  return {
    authPath: path.join(dataRoot, 'auth.json'),
    mcpAuthPath: path.join(dataRoot, 'mcp-auth.json'),
  };
}

export function resolveRepoAuthPaths(repoRoot: string): {
  authRepoPath: string;
  mcpAuthRepoPath: string;
} {
  const repoDataRoot = path.join(repoRoot, 'data');
  return {
    authRepoPath: path.join(repoDataRoot, 'auth.json'),
    mcpAuthRepoPath: path.join(repoDataRoot, 'mcp-auth.json'),
  };
}

export function createOnePasswordBackend(options: {
  $: Shell;
  locations: SyncLocations;
  config: OnePasswordConfig;
}): SecretsBackend {
  const { $, locations, config } = options;
  const { authPath, mcpAuthPath } = resolveAuthFilePaths(locations);

  const pull = async (): Promise<void> => {
    await ensureOpAvailable($);
    await pullDocument($, config.vault, config.documents.authJson, authPath);
    await pullDocument($, config.vault, config.documents.mcpAuthJson, mcpAuthPath);
  };

  const push = async (): Promise<void> => {
    await ensureOpAvailable($);
    await pushDocument($, config.vault, config.documents.authJson, authPath);
    await pushDocument($, config.vault, config.documents.mcpAuthJson, mcpAuthPath);
  };

  const status = async (): Promise<string> => {
    await ensureOpAvailable($);
    return `1Password backend configured for vault "${config.vault}".`;
  };

  return { pull, push, status };
}

async function ensureOpAvailable($: Shell): Promise<void> {
  try {
    await $`op --version`.quiet();
  } catch {
    throw new SyncCommandError('1Password CLI not found. Install it and sign in with `op signin`.');
  }
}

async function pullDocument(
  $: Shell,
  vault: string,
  documentName: string,
  targetPath: string
): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-synced-'));
  const tempPath = path.join(tempDir, path.basename(targetPath));

  try {
    const result = await opDocumentGet($, vault, documentName, tempPath);
    if (result === 'not_found') {
      return;
    }
    await replaceFile(tempPath, targetPath);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function pushDocument(
  $: Shell,
  vault: string,
  documentName: string,
  sourcePath: string
): Promise<void> {
  if (!(await pathExists(sourcePath))) {
    return;
  }

  try {
    await opDocumentEdit($, vault, documentName, sourcePath);
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new SyncCommandError(`1Password update failed: ${formatShellError(error)}`);
    }
    try {
      await opDocumentCreate($, vault, documentName, sourcePath);
    } catch (createError) {
      throw new SyncCommandError(`1Password create failed: ${formatShellError(createError)}`);
    }
  }
}

async function opDocumentGet(
  $: Shell,
  vault: string,
  name: string,
  outFile: string
): Promise<'ok' | 'not_found'> {
  try {
    await $`op document get ${name} --vault ${vault} --out-file ${outFile}`.quiet();
    return 'ok';
  } catch (error) {
    if (isNotFoundError(error)) {
      return 'not_found';
    }
    throw new SyncCommandError(`1Password download failed: ${formatShellError(error)}`);
  }
}

async function opDocumentCreate(
  $: Shell,
  vault: string,
  name: string,
  sourcePath: string
): Promise<void> {
  await $`op document create --vault ${vault} ${sourcePath} --title ${name}`.quiet();
}

async function opDocumentEdit(
  $: Shell,
  vault: string,
  name: string,
  sourcePath: string
): Promise<void> {
  await $`op document edit ${name} --vault ${vault} ${sourcePath}`.quiet();
}

async function replaceFile(sourcePath: string, targetPath: string): Promise<void> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await chmodIfExists(sourcePath, 0o600);
  try {
    await fs.rename(sourcePath, targetPath);
  } catch (error) {
    const maybeErrno = error as NodeJS.ErrnoException;
    if (maybeErrno.code !== 'EXDEV') {
      throw error;
    }
    await fs.copyFile(sourcePath, targetPath);
    await fs.unlink(sourcePath);
  }
  await chmodIfExists(targetPath, 0o600);
}

function isNotFoundError(error: unknown): boolean {
  const text = formatShellError(error);
  return /not found/i.test(text);
}

function formatShellError(error: unknown): string {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;

  const maybe = error as { stderr?: string; message?: string };
  const parts = [maybe.stderr, maybe.message].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
  if (parts.length > 0) return parts.join('\n');

  return String(error);
}
