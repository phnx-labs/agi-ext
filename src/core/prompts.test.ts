import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readPromptsFromPath, writePromptsToPath, DEFAULT_PROMPTS } from './prompts';
import { PromptEntry } from './settings';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const entry: PromptEntry = { id: 'test-1', title: 'Test', content: 'Body', isFavorite: false, createdAt: 1000, updatedAt: 2000, accessedAt: 3000 };

describe('readPromptsFromPath', () => {
  test('a missing, empty, corrupt or non-list file reads as the defaults', () => {
    expect(readPromptsFromPath(path.join(dir, 'missing.json'))).toEqual({ prompts: DEFAULT_PROMPTS, usedDefaults: true });
    for (const body of ['', '[]', '{ not valid json [[[', '{"key": "value"}']) {
      const file = path.join(dir, 'p.json');
      fs.writeFileSync(file, body);
      expect(readPromptsFromPath(file)).toEqual({ prompts: DEFAULT_PROMPTS, usedDefaults: true });
    }
  });

  test('reads stored prompts, giving an old entry without accessedAt a 0', () => {
    const file = path.join(dir, 'p.json');
    const { accessedAt: _drop, ...old } = { ...entry, id: 'old' };
    fs.writeFileSync(file, JSON.stringify([entry, old]));
    expect(readPromptsFromPath(file)).toEqual({ prompts: [entry, { ...old, accessedAt: 0 }], usedDefaults: false });
  });
});

describe('writePromptsToPath', () => {
  test('creates the directory and writes JSON that reads back', () => {
    const file = path.join(dir, 'nested', 'prompts.json');
    expect(writePromptsToPath(file, [entry])).toBe(true);
    expect(readPromptsFromPath(file).prompts).toEqual([entry]);
  });

  test('returns false when the path cannot be written', () => {
    fs.writeFileSync(path.join(dir, 'file'), '');
    expect(writePromptsToPath(path.join(dir, 'file', 'prompts.json'), [entry])).toBe(false);
  });
});
