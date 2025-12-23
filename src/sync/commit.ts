import type { PluginInput } from '@opencode-ai/plugin';

type CommitClient = PluginInput['client'];
type Shell = PluginInput['$'];

interface CommitContext {
  client: CommitClient;
  $: Shell;
}

export async function generateCommitMessage(
  ctx: CommitContext,
  repoDir: string,
  fallbackDate = new Date()
): Promise<string> {
  const fallback = `Sync OpenCode config (${formatDate(fallbackDate)})`;

  const diffSummary = await getDiffSummary(ctx.$, repoDir);
  if (!diffSummary) return fallback;

  const model = await resolveSmallModel(ctx.client);
  if (!model) return fallback;

  const prompt = [
    'Generate a concise single-line git commit message (max 72 chars).',
    'Focus on OpenCode config sync changes.',
    'Return only the message, no quotes.',
    '',
    'Diff summary:',
    diffSummary,
  ].join('\n');

  let sessionId: string | null = null;

  try {
    const sessionResult = await ctx.client.session.create({ body: { title: 'opencode-sync' } });
    const session = unwrapData<{ id: string }>(sessionResult);
    sessionId = session?.id ?? null;
    if (!sessionId) return fallback;

    const response = await ctx.client.session.prompt({
      path: { id: sessionId },
      body: {
        model,
        parts: [{ type: 'text', text: prompt }],
      },
    });

    const message = extractMessage(unwrapData(response) ?? response);
    if (!message) return fallback;

    const sanitized = sanitizeMessage(message);
    return sanitized || fallback;
  } catch {
    return fallback;
  } finally {
    if (sessionId) {
      try {
        await ctx.client.session.delete({ path: { id: sessionId } });
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}

function extractMessage(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;

  const parts =
    (response as { parts?: Array<{ type: string; text?: string }> }).parts ??
    (response as { info?: { parts?: Array<{ type: string; text?: string }> } }).info?.parts ??
    [];

  const textPart = parts.find((part) => part.type === 'text' && part.text);
  return textPart?.text?.trim() ?? null;
}

function sanitizeMessage(message: string): string {
  const firstLine = message.split('\n')[0].trim();
  const trimmed = firstLine.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 72) return trimmed;
  return trimmed.slice(0, 72).trim();
}

async function resolveSmallModel(
  client: CommitClient
): Promise<{ providerID: string; modelID: string } | null> {
  let config: { small_model?: string; model?: string } | null = null;
  try {
    const response = await client.config.get();
    config = unwrapData<{ small_model?: string; model?: string }>(response);
  } catch {
    return null;
  }
  if (!config) return null;
  const modelValue = config.small_model ?? config.model;
  if (!modelValue) return null;

  const [providerID, modelID] = modelValue.split('/', 2);
  if (!providerID || !modelID) return null;
  return { providerID, modelID };
}

async function getDiffSummary($: Shell, repoDir: string): Promise<string> {
  try {
    const nameStatus = await $`git -C ${repoDir} diff --name-status`.text();
    const stats = await $`git -C ${repoDir} diff --stat`.text();
    return [nameStatus.trim(), stats.trim()].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

function formatDate(date: Date): string {
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function unwrapData<T>(response: unknown): T | null {
  if (!response || typeof response !== 'object') return null;
  const maybeError = (response as { error?: unknown }).error;
  if (maybeError) return null;
  if ('data' in response) {
    const data = (response as { data?: T }).data;
    if (data !== undefined) return data;
    return null;
  }
  return response as T;
}
