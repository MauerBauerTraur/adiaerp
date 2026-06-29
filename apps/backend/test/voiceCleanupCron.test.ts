/**
 * F4.3 — voiceCleanupCron.runOneCycle unit tests.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOneCycle } from '../src/workers/voiceCleanupCron.js';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adia-voice-cleanup-test-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function touch(name: string, ageMs: number): Promise<void> {
  const full = path.join(dir, name);
  await fs.writeFile(full, 'x');
  const time = new Date(Date.now() - ageMs);
  await fs.utimes(full, time, time);
}

describe('voiceCleanupCron.runOneCycle', () => {
  it('eski adia-voice fayllarni o\'chiradi, yangilarini saqlaydi', async () => {
    await touch('adia-voice-1-2-3.oga', 2 * 60 * 60 * 1000); // 2 soat
    await touch('adia-voice-4-5-6.oga', 30 * 1000); // 30 sekund
    await touch('other-file.txt', 2 * 60 * 60 * 1000); // boshqa prefix
    const result = await runOneCycle({ dir });
    expect(result.deleted).toBe(1);
    expect(result.skipped).toBe(1);
    const left = await fs.readdir(dir);
    expect(left).toContain('adia-voice-4-5-6.oga');
    expect(left).toContain('other-file.txt');
    expect(left).not.toContain('adia-voice-1-2-3.oga');
  });

  it('bo\'sh dir — 0/0', async () => {
    const result = await runOneCycle({ dir });
    expect(result.deleted).toBe(0);
    expect(result.skipped).toBe(0);
  });

  it('maxAgeMs override ishlaydi', async () => {
    await touch('adia-voice-1-2-3.oga', 5 * 60 * 1000); // 5 min
    const r1 = await runOneCycle({ dir, maxAgeMs: 10 * 60 * 1000 });
    expect(r1.deleted).toBe(0);
    expect(r1.skipped).toBe(1);
    const r2 = await runOneCycle({ dir, maxAgeMs: 60 * 1000 });
    expect(r2.deleted).toBe(1);
  });
});
