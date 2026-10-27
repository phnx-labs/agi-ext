import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const RETRY_MS = 10 * 60_000;
const MAX_BYTES = 2 * 1024 * 1024;

/** People's pictures (Linear assignees, GitHub PR authors), each downloaded once into
 *  `dir` and drawn from there, so no redraw, window or restart fetches one again. */
export class AvatarCache {
  private readonly known = new Map<string, string>();
  private readonly fetching = new Set<string>();
  private readonly failedAt = new Map<string, number>();

  constructor(private readonly dir: string, private readonly onFetched: () => void) {}

  /** The picture's file, or null while its one download runs (then `onFetched`). */
  file(url: string): string | null {
    const hit = this.known.get(url);
    if (hit) return hit;
    const stem = path.join(this.dir, createHash('sha256').update(url).digest('hex').slice(0, 32));
    for (const ext of Object.values(TYPES)) {
      if ((fs.statSync(`${stem}.${ext}`, { throwIfNoEntry: false })?.size ?? 0) > 0) {
        this.known.set(url, `${stem}.${ext}`);
        return `${stem}.${ext}`;
      }
    }
    if (!this.fetching.has(url) && Date.now() - (this.failedAt.get(url) ?? 0) >= RETRY_MS) void this.fetch(url, stem);
    return null;
  }

  private async fetch(url: string, stem: string): Promise<void> {
    this.fetching.add(url);
    const tmp = `${stem}.${process.pid}.tmp`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      const ext = TYPES[(res.headers.get('content-type') ?? '').split(';')[0]!.trim()];
      if (!res.ok || !ext) throw new Error(`${res.status} ${res.headers.get('content-type')}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_BYTES) throw new Error(`${bytes.length} bytes`);
      await fs.promises.mkdir(this.dir, { recursive: true });
      await fs.promises.writeFile(tmp, bytes);
      await fs.promises.rename(tmp, `${stem}.${ext}`);
      this.known.set(url, `${stem}.${ext}`);
      this.onFetched();
    } catch {
      this.failedAt.set(url, Date.now());
      await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    } finally {
      this.fetching.delete(url);
    }
  }
}
