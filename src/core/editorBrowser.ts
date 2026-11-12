// The editor-browser contract with browser-cli: this window announces its
// built-in browser bridge in $AGENTS_HOME/browser/run/editors/<id>.json, which
// `browser profiles list` reads (browser-cli `src/browser/editor-discovery.ts`).
// Change the format in both repos together and bump `v`.
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export const EXTENSION_ID = 'swarmify.swarm-ext';

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

function stripJsonComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str: string | undefined) => str ?? '');
}

// Adds this extension to argv.json's `enable-proposed-api`, keeping the file's
// comments and layout. Returns null when it is already there.
export function addProposedApiOptIn(text: string, extensionId = EXTENSION_ID): string | null {
  const existing = /("enable-proposed-api"\s*:\s*\[)([^\]]*)\]/.exec(text);
  if (existing) {
    if (existing[2].includes(`"${extensionId}"`)) return null;
    const separator = existing[2].trim() ? ', ' : '';
    const at = existing.index + existing[1].length;
    return `${text.slice(0, at)}"${extensionId}"${separator}${text.slice(at)}`;
  }
  const open = text.indexOf('{');
  if (open < 0) return `{\n\t"enable-proposed-api": ["${extensionId}"]\n}\n`;
  const body = stripJsonComments(text.slice(open + 1, text.lastIndexOf('}')));
  const comma = body.trim() ? ',' : '';
  return `${text.slice(0, open + 1)}\n\t"enable-proposed-api": ["${extensionId}"]${comma}${text.slice(open + 1)}`;
}
