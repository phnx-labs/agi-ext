import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

type Agent = 'claude';

const SERVER_NAME = 'watchdog';

async function isCliAvailable(agent: Agent): Promise<boolean> {
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    await execAsync(`${which} ${agent}`, { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function isInstalled(agent: Agent): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`${agent} mcp list`, { timeout: 5000 });
    return new RegExp(`\\b${SERVER_NAME}\\b`, 'i').test(stdout);
  } catch {
    return false;
  }
}

async function install(agent: Agent, mcpServerPath: string): Promise<void> {
  const cmd = `${agent} mcp add --scope user ${SERVER_NAME} node "${mcpServerPath}"`;
  await execAsync(cmd, { timeout: 10000 });
}

// Memoize per extension load: this runs on every activation, but the two
// `which`/`mcp list` subprocesses only need to run once per process. Repeat
// callers get the in-flight/completed promise instead of re-forking.
let installPromise: Promise<void> | null = null;

async function ensureOne(agent: Agent, mcpServerPath: string): Promise<void> {
  if (!(await isCliAvailable(agent))) {
    return;
  }
  try {
    if (await isInstalled(agent)) {
      return;
    }
    await install(agent, mcpServerPath);
    console.log(`[WATCHDOG] Registered ${SERVER_NAME} MCP for ${agent}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[WATCHDOG] Failed to register MCP for ${agent}: ${message}`);
  }
}

/**
 * Register the watchdog MCP server in Claude's user-scope config so peer
 * terminals can call `send_to_agent`. Skip an absent CLI or existing entry.
 */
export function ensureWatchdogMcpInstalled(mcpServerPath: string): Promise<void> {
  if (installPromise) return installPromise;
  installPromise = ensureOne('claude', mcpServerPath);
  return installPromise;
}
