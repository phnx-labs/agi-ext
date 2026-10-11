// Pure helpers used by the agent panel webview. Kept free of `vscode` imports
// so they can be unit-tested with `bun test` without an extension host.

export interface PullRequestRef {
  url: string;
  ownerRepo: string;
  number: number;
}

const PR_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/**
 * Find every PR URL in the supplied transcript lines, deduped by `<repo>#<num>`
 * to collapse "URL was logged 5 times" noise while preserving the order the
 * URLs first appeared (oldest first → newest last in the conversation).
 *
 * The canonical URL is rewritten to drop `www.` and force `https` so two
 * occurrences that differ only in those don't show up as distinct PRs.
 */
export function extractPrUrls(lines: string[]): PullRequestRef[] {
  const seen = new Set<string>();
  const out: PullRequestRef[] = [];
  for (const line of lines) {
    if (!line) continue;
    PR_URL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = PR_URL_RE.exec(line)) !== null) {
      const ownerRepo = m[1]!;
      const num = Number(m[2]);
      const dedupeKey = `${ownerRepo}#${num}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({
        url: `https://github.com/${ownerRepo}/pull/${num}`,
        ownerRepo,
        number: num,
      });
    }
  }
  return out;
}

export interface WorktreeRef {
  path: string;
  name: string;
  branch?: string;
  isActive: boolean;
  isMain: boolean;
}
