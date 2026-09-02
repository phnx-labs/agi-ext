// Linear project matching for managed projects.
//
// The pure matcher now lives in src/shared/linearProjects.ts so BOTH the extension
// host (src/*) and the webview (ui/* via `@shared`) share ONE implementation — the
// webview's Fleet attribution reuses matchLinearProject rather than re-deriving it.
// This module re-exports it so existing host-side importers keep their
// `from '../core/linearProjects'` path unchanged.

export {
  normalizeProjectKey,
  matchLinearProject,
  type LinearProjectLite,
} from '../shared/linearProjects';
