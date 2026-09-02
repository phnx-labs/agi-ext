import { spawn } from 'child_process';
import { resolveAgentsBin, bootstrapPath } from './agentsBin';
import { createConcurrencyLimiter } from './concurrencyLimiter';

const MAX_INPUT_CHARS = 4000;
const MAX_LABEL_CHARS = 50;
const DEFAULT_TIMEOUT_MS = 12000;
const CATALOG_TIMEOUT_MS = 3000;

// PHNX-3816: cap how many label-generating `agents run claude` subprocesses run
// at once. Auto-label pollers are armed on ~every agent-tab open/restore, and a
// mass-open (e.g. a crash-restore reopening many tabs) used to fire one full
// headless agent per unlabeled tab simultaneously — a spawn storm on top of any
// other. The limiter runs at most MAX_CONCURRENT_LABEL_GENS at once and queues
// the rest, so N tabs drain a few at a time instead of all at once. It is
// module-global so the cap holds across every tab in the window.
const MAX_CONCURRENT_LABEL_GENS = 2;
const labelGenLimiter = createConcurrencyLimiter(MAX_CONCURRENT_LABEL_GENS);

let fastModelCache: Promise<string> | null = null;

export async function generateLabelWithLLM(
  text: string | undefined,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<string | null> {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const input = trimmed.length > MAX_INPUT_CHARS ? trimmed.slice(0, MAX_INPUT_CHARS) : trimmed;
  const prompt =
    'Generate a 3-4 word title for the following task. ' +
    'Respond IMMEDIATELY with only the title. Do NOT investigate, do NOT read files, do NOT use any tools. ' +
    'No quotes, no trailing punctuation, no explanation.\n\n' +
    '---\n' +
    input +
    '\n---';

  const model = await resolveFastModel();

  // Resolve the absolute `agents` binary + bootstrapped PATH so this works when
  // the editor is launched from Dock/Finder with a minimal PATH (see agentsBin).
  let bin: string;
  let runPath: string;
  try {
    bin = await resolveAgentsBin();
    runPath = `${bootstrapPath(bin)}:${process.env.PATH ?? ''}`;
  } catch {
    return null;
  }

  // Gate the actual subprocess behind the shared limiter (PHNX-3816). The
  // per-call timeout only starts once the spawn does, so a queued call does not
  // time out while it waits for a slot.
  return labelGenLimiter.run(() => new Promise<string | null>((resolve) => {
    let stdout = '';
    let resolved = false;

    const child = spawn(
      bin,
      ['run', 'claude', prompt, '--mode', 'plan', '--model', model],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PATH: runPath } }
    );

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve(result);
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('exit', (code) => {
      if (code !== 0) return finish(null);
      finish(sanitizeLabel(stdout));
    });
  }));
}

async function resolveFastModel(): Promise<string> {
  if (!fastModelCache) {
    fastModelCache = queryFastModel().catch(() => 'haiku');
  }
  return fastModelCache;
}

interface CatalogEntry {
  catalog?: {
    aliases?: Record<string, string>;
    models?: Array<{ id: string; alias?: string }>;
  };
}

function queryFastModel(): Promise<string> {
  return resolveAgentsBin().then((bin) => new Promise<string>((resolve, reject) => {
    let stdout = '';
    let resolved = false;

    const child = spawn(bin, ['models', 'claude', '--json'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, PATH: `${bootstrapPath(bin)}:${process.env.PATH ?? ''}` },
    });

    const finish = (result: string | null) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      if (result) resolve(result); else reject(new Error('catalog unavailable'));
    };

    const timer = setTimeout(() => finish(null), CATALOG_TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('error', () => finish(null));
    child.on('exit', (code) => {
      if (code !== 0) return finish(null);
      finish(pickFastFromCatalog(stdout));
    });
  }));
}

function pickFastFromCatalog(raw: string): string | null {
  let parsed: CatalogEntry[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  const catalog = parsed[0]?.catalog;
  if (!catalog) return null;

  const aliasTarget = catalog.aliases?.haiku;
  if (aliasTarget) return 'haiku';

  const models = catalog.models ?? [];
  const aliased = models.find((m) => m.alias === 'haiku');
  if (aliased) return aliased.alias!;

  const byName = models.find((m) => m.id.includes('haiku'));
  if (byName) return byName.id;

  return null;
}

function sanitizeLabel(raw: string): string | null {
  const firstLine = raw.trim().split('\n')[0]?.trim();
  if (!firstLine) return null;
  const stripped = firstLine.replace(/^["'`]+|["'`]+$/g, '').replace(/[.!?]+$/, '').trim();
  if (!stripped) return null;
  return stripped.length > MAX_LABEL_CHARS ? stripped.slice(0, MAX_LABEL_CHARS).trim() : stripped;
}
