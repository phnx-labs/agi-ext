// Re-export of pure, testable agent metadata from src/core for consumption by
// the extension UI layer (ui/settings/) and other shared code. These modules have
// no vscode dependencies and can be imported across the extension/UI boundary.

export { CLI_AGENT_IDS, CLI_AGENT_META, isCliAgentId, type CliAgentId, type CliAgentMeta } from '../core/agents.cli';

// PRESENTED_AGENTS and associated title constants are in src/core (they read the
// title constants from utils.ts, which are pure). Export them here for the UI to
// derive tables without duplication.
//
// The UI will:
// 1. Map PRESENTED_AGENTS to get the set of presented agent keys
// 2. Use CLI_AGENT_META[key].name to get display labels
// 3. Use PRESENTED_AGENTS to find the two-letter prefix for each key
export {
  BUILT_IN_AGENTS,
  DEPRECATED_AGENT_KEYS,
  isDeprecatedAgentKey,
  webviewLaunchCommandIds,
  getBuiltInByKey,
  getBuiltInByPrefix,
  getBuiltInDefByTitle,
  type BuiltInAgentDef,
} from '../core/agents';
