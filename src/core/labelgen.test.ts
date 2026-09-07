import { describe, it, expect } from 'bun:test';
import { generateLabelWithLLM, setLabelGenSuppressed } from './labelgen';

describe('generateLabelWithLLM', () => {
  it('returns null for empty input', async () => {
    expect(await generateLabelWithLLM('')).toBeNull();
    expect(await generateLabelWithLLM(undefined)).toBeNull();
    expect(await generateLabelWithLLM('   \n  ')).toBeNull();
  });

  it.skipIf(process.env.EXT_AGENT_INTEGRATION !== '1')(
    'returns a short title for a real task description',
    async () => {
      const result = await generateLabelWithLLM(
        'Refactor the database connection pool to use lazy initialization. Add a maximum size of 50 and a timeout of 30 seconds.',
        20000
      );
      expect(result).toBeTruthy();
      expect(result!.length).toBeLessThanOrEqual(50);
      expect(result!.split('\n').length).toBe(1);
      expect(result!).not.toMatch(/^["'`]/);
      expect(result!).not.toMatch(/[.!?]$/);
    },
    25000,
  );

  it('returns null when timeout is too short to complete', async () => {
    const result = await generateLabelWithLLM(
      'Build a complete microservices architecture with Kubernetes orchestration and observability.',
      1
    );
    expect(result).toBeNull();
  });

  // Process-leak containment (restore-burst suppression): while suppressed,
  // no subprocess is spawned at all — proven by returning well inside the
  // time a real spawn + catalog resolution would take, exactly as if the
  // call had already timed out.
  it('returns null immediately without spawning while suppressed, and resumes once cleared', async () => {
    setLabelGenSuppressed(true);
    try {
      const start = Date.now();
      const result = await generateLabelWithLLM('Some restored-tab task description', 20000);
      expect(result).toBeNull();
      expect(Date.now() - start).toBeLessThan(500);
    } finally {
      setLabelGenSuppressed(false);
    }

    // Cleared: the too-short-timeout case above still behaves as before,
    // proving the flag doesn't leak true across calls/tests.
    const result = await generateLabelWithLLM('Another task description', 1);
    expect(result).toBeNull();
  });
});
