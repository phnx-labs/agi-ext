import * as vscode from 'vscode';
import { runAgentsArgs } from '../core/agentsBin';
import { parsePrForMerge, rowMergeChoices, type PrForMerge } from '../core/prStatus';

// One merge flow for every surface (the session sidebar's Merge ▾ and a Project
// panel PR row): read that one PR for its head commit, mergeability and whether
// you may bypass protection; offer squash, rebase or a merge commit when GitHub
// would merge it, and an admin merge only when you are an admin of a repo that
// allows the bypass; confirm in a modal (an admin merge in its own warning); read
// the PR again and merge only if the head did not move and the choice still
// stands; then one `agents projects prs merge … --sha <head> --method <m> [--admin]`.

/** What the flow touches, so a test can drive it without a CLI or an editor. */
interface MergeDeps {
  run: (args: string[], options: { timeout: number }) => Promise<{ stdout: string }>;
  ui: Pick<typeof vscode.window, 'showQuickPick' | 'showWarningMessage' | 'showInformationMessage'>;
}

/** Pick, confirm and run one merge; true when it merged. Throws the CLI's error. */
export async function mergeWithMenu(project: string, repo: string, number: number, deps: MergeDeps = { run: runAgentsArgs, ui: vscode.window }): Promise<boolean> {
  const { run, ui } = deps;
  const readPr = async (): Promise<PrForMerge | undefined> => {
    const { stdout } = await run(['projects', 'prs', project, '--json', '--repo', repo, '--number', String(number)], { timeout: 60_000 });
    return parsePrForMerge(stdout, repo, number);
  };
  const pr = await readPr();
  const choices = rowMergeChoices(pr);
  if (!pr || !pr.headSha || !choices.length) {
    void ui.showWarningMessage(`${repo}#${number} cannot be merged from here${pr?.isDraft ? ': it is a draft' : pr?.mergeableState === 'dirty' ? ': it has conflicts' : ''}.`);
    return false;
  }
  const head = pr.headSha.slice(0, 7);
  const picked = await ui.showQuickPick(
    choices.map((c) => ({ label: (c.admin ? '$(shield) ' : '') + c.label, description: c.detail, choice: c })),
    { title: `Merge ${repo}#${number} at ${head}`, placeHolder: 'How to merge' },
  );
  if (!picked) return false;
  const c = picked.choice;
  const go = c.admin ? 'Merge as admin' : 'Merge';
  const ask = c.admin
    ? `Admin merge ${repo}#${number} at ${head}? This bypasses branch protection (required reviews and checks) as a repository admin.`
    : `${c.label}: ${repo}#${number} at ${head}?`;
  if (await ui.showWarningMessage(ask, { modal: true }, go) !== go) return false;
  // The PR may have moved while the dialog was open: a new commit, a red check,
  // changes requested. Merge only if the head is the one shown and the choice stands.
  const now = await readPr();
  const still = rowMergeChoices(now).some((x) => x.method === c.method && x.admin === c.admin);
  if (!now || now.headSha !== pr.headSha || !still) {
    void ui.showWarningMessage(`Did not merge ${repo}#${number}: it changed while the dialog was open.`);
    return false;
  }
  await run(['projects', 'prs', 'merge', project, '--repo', repo, '--number', String(number), '--sha', pr.headSha, '--method', c.method, ...(c.admin ? ['--admin'] : [])], { timeout: 60_000 });
  void ui.showInformationMessage(`Merged ${repo}#${number}${c.admin ? ' as admin' : ''}.`);
  return true;
}
