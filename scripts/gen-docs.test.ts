import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const files = ['reference.html', 'reference.json'];
const scratch = join(root, '.agents/scratch');
mkdirSync(scratch, { recursive: true });

function run(args: string[], cwd = root) {
  return spawnSync(process.execPath, [join(root, 'scripts/gen-docs.ts'), ...args], { cwd, encoding: 'utf8', timeout: 60_000 });
}

test('the real manifest and ui/ tree generate a complete reference; --check catches drift without writing', () => {
  const cwd = mkdtempSync(join(scratch, 'gen-docs-'));
  const args = ['--out-dir', 'out dir'];
  const out = join(cwd, 'out dir');
  try {
    const first = run(args, cwd);
    expect(first.status, first.stderr).toBe(0);
    const original = files.map((f) => readFileSync(join(out, f), 'utf8'));
    const reference = JSON.parse(original[1]!);
    const contributes = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).contributes;
    expect(reference.counts.commands).toBe(contributes.commands.length);
    expect(reference.counts.settings).toBe(Object.keys(contributes.configuration.properties).length);
    expect(reference.counts.keybindings).toBe(contributes.keybindings.length);

    const component = (name: string) => reference.components.find((c: { name: string }) => c.name === name);
    // Props come from the TypeScript types, JSDoc included.
    const topBar = component('TopBar');
    expect(topBar.file).toBe('ui/settings/components/mission-control/TopBar.tsx');
    expect(topBar.props.find((p: { name: string }) => p.name === 'onDispatch')).toMatchObject({ type: '() => void', optional: true });
    expect(topBar.props.find((p: { name: string }) => p.name === 'onDispatch').description).toContain('Dispatch button');
    // The pane is found through references, not only JSX: the editor mounts this one with ReactRenderer.
    expect(component('SlashCommandsList').usedIn).toEqual(['custom editor "Agents Reader (Markdown)" › Editor']);
    expect(original[0]).toContain('<nav');
    expect(original[0]).toContain('agents.disableAutopush');

    const mtimes = files.map((f) => statSync(join(out, f)).mtimeMs);
    expect(run([...args, '--check'], cwd).status).toBe(0);
    expect(files.map((f) => statSync(join(out, f)).mtimeMs)).toEqual(mtimes);

    writeFileSync(join(out, files[0]!), 'stale');
    rmSync(join(out, files[1]!));
    const stale = run([...args, '--check'], cwd);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain('reference.html, reference.json');
    expect(readFileSync(join(out, files[0]!), 'utf8')).toBe('stale');

    expect(run(args, cwd).status).toBe(0);
    expect(files.map((f) => readFileSync(join(out, f), 'utf8'))).toEqual(original);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120_000);

test('the committed docs/reference.{html,json} match package.json and ui/', () => {
  const check = run(['--check'], scratch);
  expect(check.status, check.stderr).toBe(0);
}, 60_000);
