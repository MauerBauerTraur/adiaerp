/**
 * Yandex Cloud smoke test — `npm run yandex:test -w @adia/backend`.
 *
 * Exercises the live STT v1 short-recognize endpoint with a small fixture.
 * Exits 0 on success, 1 on any failure (so CI can gate on it later).
 *
 * Fixture: `test/fixtures/hello-test.opus` — a short OGG/Opus clip. When the
 * fixture is missing the script prints a friendly hint and exits 1 instead
 * of throwing a confusing `ENOENT`.
 */
import { readFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config/index.js';
import { recognizeShort } from '../src/integrations/yandex/stt.js';
import { getIamToken, getCachedIamExpiry } from '../src/integrations/yandex/auth.js';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'test') process.env.NODE_ENV = 'development';
  const cfg = loadConfig();
  if (!cfg.yandex.enabled) {
    console.error(
      '[yandex-test] disabled — set YANDEX_OAUTH_TOKEN, YANDEX_FOLDER_ID, ' +
        'YANDEX_BUCKET in .env (run `npm run yandex:bootstrap` first).',
    );
    process.exitCode = 1;
    return;
  }
  console.log('[yandex-test] config', {
    folderId: cfg.yandex.folderId,
    bucket: cfg.yandex.bucket,
  });

  // Step 1 — mint the IAM token. Surfaces auth issues with a clean message.
  try {
    await getIamToken();
    const exp = getCachedIamExpiry();
    console.log('[yandex-test] IAM ok', { expiresAt: exp?.toISOString() ?? '(none)' });
  } catch (err) {
    console.error('[yandex-test] IAM exchange FAILED', (err as Error).message);
    process.exitCode = 1;
    return;
  }

  // Step 2 — load the fixture (kept under test/ so we can ship it without
  // bloating the runtime bundle).
  const fixturePath = resolve(process.cwd(), 'test/fixtures/hello-test.opus');
  try {
    await access(fixturePath);
  } catch {
    console.error(
      '[yandex-test] fixture missing — expected at ' + fixturePath + '.\n' +
        '   To create one, record a short clip and save it as that file. ' +
        'See docs/specs/F4.2-voice-pipeline.md for the recommended format.',
    );
    process.exitCode = 1;
    return;
  }
  const audio = await readFile(fixturePath);
  console.log('[yandex-test] fixture loaded', { bytes: audio.byteLength });

  // Step 3 — recognize.
  try {
    const r = await recognizeShort(audio, { lang: 'uz-UZ', format: 'oggopus' });
    console.log('[yandex-test] STT ok', { elapsedMs: r.elapsedMs });
    console.log('--- transcript ---');
    console.log(r.text === '' ? '(empty — no speech detected)' : r.text);
  } catch (err) {
    console.error('[yandex-test] STT FAILED', (err as Error).message);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[yandex-test] uncaught', (err as Error).message);
  process.exitCode = 1;
});
