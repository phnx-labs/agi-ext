// Git commit generation - pure functions (testable)

// Parse ignore patterns from comma-separated string
export function parseIgnorePatterns(ignoreFilesRaw: string): string[] {
  if (!ignoreFilesRaw) return [];
  return ignoreFilesRaw.split(',').map(p => p.trim()).filter(Boolean);
}

// Check if a file path should be ignored based on patterns
export function shouldIgnoreFile(filePath: string, ignorePatterns: string[]): boolean {
  return ignorePatterns.some(pattern => {
    if (pattern.startsWith('*.')) {
      return filePath.endsWith(pattern.slice(1));
    }
    return filePath.includes(`/${pattern}/`) || filePath.includes(`/${pattern}`) || filePath.endsWith(`/${pattern}`);
  });
}

// Format git status for a change
export function formatChangeStatus(status: number, staged: boolean): string {
  const statusText = status === 7 ? 'New' :
    status === 5 ? 'Modified' :
      status === 6 ? 'Deleted' : 'Changed';
  return staged ? `Staged ${statusText}` : `Unstaged ${statusText}`;
}

export interface DirectoryMove {
  fromPrefix: string;
  toPrefix: string;
  fileCount: number;
  dirName: string;
}

export function detectDirectoryMoves(
  deletedPaths: string[],
  addedPaths: string[],
  minMatchThreshold: number = 5
): DirectoryMove | null {
  if (deletedPaths.length < minMatchThreshold || addedPaths.length < minMatchThreshold) {
    return null;
  }

  const addedSet = new Set(addedPaths);
  const deletedByPrefix = new Map<string, string[]>();

  for (const deletedPath of deletedPaths) {
    const parts = deletedPath.split('/').filter(Boolean);
    if (parts.length < 2) continue;

    for (let i = 1; i <= parts.length - 1; i++) {
      const prefix = parts.slice(0, i).join('/') + '/';
      if (!deletedByPrefix.has(prefix)) {
        deletedByPrefix.set(prefix, []);
      }
      deletedByPrefix.get(prefix)!.push(deletedPath);
    }
  }

  for (const [prefix, deletedFiles] of deletedByPrefix.entries()) {
    if (deletedFiles.length < minMatchThreshold) continue;

    const relativePaths = deletedFiles.map(path => {
      if (path.startsWith(prefix)) {
        return path.slice(prefix.length);
      }
      return path;
    });

    let matchCount = 0;
    for (const relPath of relativePaths) {
      if (addedSet.has(relPath)) {
        matchCount++;
      }
    }

    if (matchCount >= minMatchThreshold) {
      const prefixParts = prefix.split('/').filter(Boolean);
      const dirName = prefixParts[prefixParts.length - 1];
      return {
        fromPrefix: prefix,
        toPrefix: '',
        fileCount: matchCount,
        dirName: dirName
      };
    }

    const prefixParts = prefix.split('/').filter(Boolean);
    if (prefixParts.length >= 2) {
      const parentPrefix = prefixParts.slice(0, -1).join('/') + '/';
      matchCount = 0;

      for (const relPath of relativePaths) {
        const parentPath = parentPrefix + relPath;
        if (addedSet.has(parentPath)) {
          matchCount++;
        }
      }

      if (matchCount >= minMatchThreshold) {
        const dirName = prefixParts[prefixParts.length - 1];
        return {
          fromPrefix: prefix,
          toPrefix: parentPrefix,
          fileCount: matchCount,
          dirName: dirName
        };
      }
    }
  }

  return null;
}

// Build the prompt sent to Claude CLI for commit message generation.
// Style rules mirror ~/.agents-system/commands/commit.md.
export function buildCommitPrompt(
  statusChanges: string,
  diffSummary: string,
  commitMessageExamples: string[]
): string {
  const examplesSection = commitMessageExamples.length > 0
    ? `\n\nStyle examples (match the voice):\n${commitMessageExamples.map(ex => `- ${ex}`).join('\n')}`
    : '';

  return `Write ONE conventional-commit message for the staged changes below.

Respond IMMEDIATELY with only the commit message. Do NOT investigate, do NOT read files, do NOT use tools.

Format: <type>: <description>
Types: feat, fix, docs, refactor, test, build, release, chore

Rules:
- Single line, under 72 characters.
- Lowercase. Imperative mood ("add", "fix", "update" — not "added", "fixes").
- No body, no trailers, no Co-Authored-By, no "Generated with" lines.
- No scope prefix like feat(api): — just feat:.
- No emojis. No quotes around the message. No leading/trailing punctuation.

Git status:
${statusChanges}

${diffSummary ? `Diff preview:\n${diffSummary}` : ''}${examplesSection}

Output the commit message and nothing else.`;
}
