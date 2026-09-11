// The pure agent catalog for the extension UI (ui/settings/ reaches it through
// the @shared Vite alias). Neither source module imports vscode. Re-export only
// what the UI imports so the dead-code gate sees real usage.

export { CLI_AGENT_IDS, CLI_AGENT_META, type CliAgentId } from '../core/agents.cli';
export { BUILT_IN_AGENTS } from '../core/agents';
