// The editor-browser contract with browser-cli: this window announces its
// built-in browser bridge in $AGENTS_HOME/browser/run/editors/<id>.json, which
// `browser profiles list` reads (browser-cli `src/browser/editor-discovery.ts`).
// Change the format in both repos together and bump `v`.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';

const EXTENSION_ID = 'swarmify.swarm-ext';

export interface EditorEndpoint {
  v: 1;
  id: string;
  app: string;
  appVersion: string;
  workspace: string | null;
  pid: number;
  port: number;
  token: string;
  startedAt: string;
}

export function editorEndpointsDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.AGENTS_HOME ?? path.join(env.HOME || os.homedir(), '.agents');
  return path.join(home, 'browser', 'run', 'editors');
}

// Stable per editor and folder, so an alias browser-cli saved for this window
// keeps working after a restart. An empty window has no folder to key on.
export function editorWindowId(app: string, workspaceKey: string | undefined): string {
  if (!workspaceKey) return crypto.randomBytes(16).toString('hex');
  return crypto.createHash('sha256').update(`${app}\n${workspaceKey}`).digest('hex').slice(0, 32);
}

export function newBridgeToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function tokensMatch(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function writeEditorEndpoint(endpoint: EditorEndpoint, dir = editorEndpointsDir()): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${endpoint.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(endpoint, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return file;
}

// Remove only our own announcement: a second window on the same folder may
// have replaced it with its own port and token since.
export function removeEditorEndpoint(file: string, token: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<EditorEndpoint>;
    if (current.token === token) fs.unlinkSync(file);
  } catch {
    // Already gone or unreadable: nothing of ours to remove.
  }
}

// argv.json lives in the editor's data folder (`~/.vscode-oss` for VSCodium,
// `~/.vscode` for VS Code), or in VSCODE_PORTABLE for a portable install.
export function argvJsonPath(appRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.VSCODE_PORTABLE) return path.join(env.VSCODE_PORTABLE, 'argv.json');
  const product = JSON.parse(fs.readFileSync(path.join(appRoot, 'product.json'), 'utf8')) as { dataFolderName?: string };
  return path.join(os.homedir(), product.dataFolderName || '.vscode', 'argv.json');
}

// Adds this extension to argv.json's `enable-proposed-api` through VS Code's
// own JSONC library, so comments and layout survive and a commented-out entry
// never counts. Returns null when it is already enabled; throws rather than
// write a file the editor could not read.
export function addProposedApiOptIn(text: string, extensionId = EXTENSION_ID): string | null {
  const errors: ParseError[] = [];
  const parsed = (text.trim() ? parse(text, errors, { allowTrailingComma: true }) : {}) as Record<string, unknown> | undefined;
  if (errors.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('argv.json is not a JSON object; fix it by hand, then run the command again');
  }
  const current = parsed['enable-proposed-api'];
  const list = Array.isArray(current) ? current.filter((x): x is string => typeof x === 'string') : [];
  if (list.includes(extensionId)) return null;
  const base = text.trim() ? text : '{\n}\n';
  const format = { insertSpaces: false, tabSize: 1, eol: '\n' };
  const next = applyEdits(base, modify(base, ['enable-proposed-api'], [extensionId, ...list], { formattingOptions: format }));
  const check = parse(next, [], { allowTrailingComma: true }) as Record<string, unknown>;
  if (!Array.isArray(check['enable-proposed-api']) || !check['enable-proposed-api'].includes(extensionId)) {
    throw new Error('Could not add the Agents extension to argv.json');
  }
  return next;
}
