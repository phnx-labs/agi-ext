import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { shellQuote } from './shellQuote';

test('a quoted value reaches the shell as exactly one literal argument', () => {
  for (const value of ['plain', 'two words', "it's", "x'; whoami #", '$(id) `id` $HOME', '']) {
    const out = execFileSync('bash', ['-c', `printf %s ${shellQuote(value)}`], { encoding: 'utf8' });
    expect(out).toBe(value);
  }
});
