/**
 * Yandex Cloud provisioning bootstrap — `npm run yandex:bootstrap -w @adia/backend`.
 *
 * One-shot, idempotent setup that prepares the cloud resources the voice
 * pipeline (F4.2 / ADR-0013) needs:
 *
 *   1. Exchange the OAuth token for an IAM token.
 *   2. Discover the first available cloud + folder.
 *   3. Find-or-create a service account `adia-erp-stt` in that folder.
 *   4. Grant the SA the `storage.editor` and `ai.speechkit-stt.user` roles
 *      on that folder (idempotent — Yandex deduplicates identical bindings).
 *   5. Mint static AWS-compatible access keys for the SA (skipped when an
 *      `YANDEX_SA_ACCESS_KEY` is already present in env — we cannot list
 *      existing key bodies, so we let the operator re-use the one they
 *      already saved).
 *   6. Find-or-create an Object Storage bucket via the Yandex native API.
 *
 * The script writes NOTHING to disk. On success it prints a `.env` snippet
 * the owner pastes into `.env`. Secrets in the snippet are NOT masked (the
 * operator needs them); the script ALSO prints a masked summary at the
 * very end so the chat transcript stays clean.
 *
 * Exit code: 0 on success, 1 on any failure.
 */
import { exchangeOAuthForIam } from '../src/integrations/yandex/auth.js';
import { loadConfig } from '../src/config/index.js';

const RM_BASE = 'https://resource-manager.api.cloud.yandex.net/resource-manager/v1';
const IAM_BASE = 'https://iam.api.cloud.yandex.net/iam/v1';
// NOTE: Yandex uses `aws-compatibility` (singular noun in the path), NOT
// `aws-compatible`. The doc page is also somewhat hidden — see
// https://yandex.cloud/en/docs/iam/operations/sa/create-access-key.
const IAM_AWS_BASE = 'https://iam.api.cloud.yandex.net/iam/aws-compatibility/v1';
const STORAGE_BASE = 'https://storage.api.cloud.yandex.net/storage/v1';

const SA_NAME = 'adia-erp-stt';
const BUCKET_PREFIX = 'adia-erp-voice-';

// ---------------------------------------------------------------------------
// Small typed fetch helper
// ---------------------------------------------------------------------------

async function api<T = unknown>(
  url: string,
  init: RequestInit & { bearer: string },
): Promise<T> {
  const { bearer, ...rest } = init;
  const headers = new Headers(rest.headers);
  headers.set('authorization', `Bearer ${bearer}`);
  if (rest.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await globalThis.fetch(url, { ...rest, headers });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `[yandex-bootstrap] ${rest.method ?? 'GET'} ${url} → HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  if (text === '') return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

function rand6(): string {
  return Math.random().toString(36).slice(2, 8);
}

function mask(s: string): string {
  if (s.length <= 6) return '***';
  return `${s.slice(0, 3)}…${s.slice(-3)}`;
}

// ---------------------------------------------------------------------------
// Discovery + provisioning steps
// ---------------------------------------------------------------------------

type CloudRow = { id: string; name: string };
type FolderRow = { id: string; name: string; status?: string };
type ServiceAccount = { id: string; name: string };

async function discoverCloud(bearer: string): Promise<CloudRow> {
  const body = await api<{ clouds?: CloudRow[] }>(`${RM_BASE}/clouds`, {
    method: 'GET',
    bearer,
  });
  const list = body.clouds ?? [];
  if (list.length === 0) {
    throw new Error('No clouds visible to this OAuth token. Open https://console.cloud.yandex.com/ and create one.');
  }
  const chosen = list[0]!;
  return chosen;
}

async function discoverFolder(bearer: string, cloudId: string): Promise<FolderRow> {
  const body = await api<{ folders?: FolderRow[] }>(
    `${RM_BASE}/folders?cloudId=${encodeURIComponent(cloudId)}`,
    { method: 'GET', bearer },
  );
  const folders = (body.folders ?? []).filter((f) => f.status !== 'DELETING');
  if (folders.length === 0) {
    throw new Error(`No folders in cloud ${cloudId}.`);
  }
  // Prefer "default", else the first one.
  const def = folders.find((f) => f.name === 'default');
  return def ?? folders[0]!;
}

async function findOrCreateServiceAccount(
  bearer: string,
  folderId: string,
): Promise<ServiceAccount> {
  const list = await api<{ serviceAccounts?: ServiceAccount[] }>(
    `${IAM_BASE}/serviceAccounts?folderId=${encodeURIComponent(folderId)}`,
    { method: 'GET', bearer },
  );
  const existing = (list.serviceAccounts ?? []).find((sa) => sa.name === SA_NAME);
  if (existing) {
    console.log(`[bootstrap] service account already exists: ${SA_NAME} (${mask(existing.id)})`);
    return existing;
  }
  console.log(`[bootstrap] creating service account ${SA_NAME}…`);
  // POST returns a long-running operation; the metadata carries the SA id.
  type Op = {
    done?: boolean;
    response?: { id?: string; name?: string };
    metadata?: { serviceAccountId?: string };
  };
  const op = await api<Op>(`${IAM_BASE}/serviceAccounts`, {
    method: 'POST',
    bearer,
    body: JSON.stringify({
      folderId,
      name: SA_NAME,
      description: 'ADIA ERP — voice pipeline (STT + Object Storage)',
    }),
  });
  const id = op.response?.id ?? op.metadata?.serviceAccountId;
  if (id === undefined || id === '') {
    throw new Error('Service account creation returned no id.');
  }
  return { id, name: SA_NAME };
}

async function grantRoles(bearer: string, folderId: string, saId: string): Promise<void> {
  console.log('[bootstrap] granting storage.editor + ai.speechkit-stt.user…');
  // `updateAccessBindings` with `ADD` deltas is idempotent — Yandex
  // deduplicates identical bindings server-side.
  const accessBindingDeltas = [
    {
      action: 'ADD',
      accessBinding: {
        roleId: 'storage.editor',
        subject: { id: saId, type: 'serviceAccount' },
      },
    },
    {
      action: 'ADD',
      accessBinding: {
        roleId: 'ai.speechkit-stt.user',
        subject: { id: saId, type: 'serviceAccount' },
      },
    },
  ];
  try {
    await api(`${RM_BASE}/folders/${encodeURIComponent(folderId)}:updateAccessBindings`, {
      method: 'POST',
      bearer,
      body: JSON.stringify({ accessBindingDeltas }),
    });
  } catch (err) {
    const msg = (err as Error).message;
    // ALREADY_EXISTS is fine; rethrow anything else.
    if (!/already/i.test(msg)) {
      throw err;
    }
    console.log('[bootstrap] roles already bound — ok');
  }
}

async function mintAccessKey(
  bearer: string,
  saId: string,
): Promise<{ accessKey: string; secret: string }> {
  console.log('[bootstrap] minting static S3-compatible access key…');
  type KeyResponse = {
    accessKey?: { id?: string; keyId?: string };
    secret?: string;
  };
  const body = await api<KeyResponse>(`${IAM_AWS_BASE}/accessKeys`, {
    method: 'POST',
    bearer,
    body: JSON.stringify({ serviceAccountId: saId, description: 'adia-erp-voice' }),
  });
  // The response field is `keyId` (legacy `id` on some shapes).
  const accessKey = body.accessKey?.keyId ?? body.accessKey?.id ?? '';
  const secret = body.secret ?? '';
  if (accessKey === '' || secret === '') {
    throw new Error('Access-key creation returned no keyId/secret.');
  }
  return { accessKey, secret };
}

async function findOrCreateBucket(
  bearer: string,
  folderId: string,
  envBucket: string,
): Promise<string> {
  // Re-use the existing bucket name when the operator already saved one.
  const candidate = envBucket !== '' ? envBucket : `${BUCKET_PREFIX}${rand6()}`;
  // List existing buckets — Yandex's native Storage API supports
  // GET /storage/v1/buckets?folderId=
  type BucketRow = { id: string; name: string; folderId: string };
  const list = await api<{ buckets?: BucketRow[] }>(
    `${STORAGE_BASE}/buckets?folderId=${encodeURIComponent(folderId)}`,
    { method: 'GET', bearer },
  );
  const existing = (list.buckets ?? []).find((b) => b.name === candidate);
  if (existing) {
    console.log(`[bootstrap] bucket already exists: ${candidate}`);
    return candidate;
  }
  console.log(`[bootstrap] creating bucket ${candidate}…`);
  await api(`${STORAGE_BASE}/buckets`, {
    method: 'POST',
    bearer,
    body: JSON.stringify({
      folderId,
      name: candidate,
      defaultStorageClass: 'STANDARD',
      maxSize: '1073741824', // 1 GiB soft cap; voice clips are tiny.
      anonymousAccessFlags: { read: false, list: false, configRead: false },
    }),
  });
  return candidate;
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Force non-test config so optional() reads work even if NODE_ENV leaks in.
  if (process.env.NODE_ENV === 'test') process.env.NODE_ENV = 'development';
  const cfg = loadConfig();
  if (cfg.yandex.oauthToken === '') {
    console.error('[bootstrap] YANDEX_OAUTH_TOKEN is empty — set it in .env first.');
    process.exitCode = 1;
    return;
  }

  console.log('[bootstrap] exchanging OAuth → IAM…');
  const { iamToken, expiresAt } = await exchangeOAuthForIam(cfg.yandex.oauthToken);
  console.log(`[bootstrap] IAM token minted (expires ${expiresAt.toISOString()})`);

  const cloud = await discoverCloud(iamToken);
  console.log(`[bootstrap] cloud: ${cloud.name} (${mask(cloud.id)})`);

  const folder = await discoverFolder(iamToken, cloud.id);
  console.log(`[bootstrap] folder: ${folder.name} (${mask(folder.id)})`);

  const sa = await findOrCreateServiceAccount(iamToken, folder.id);
  console.log(`[bootstrap] service account: ${sa.name} (${mask(sa.id)})`);

  await grantRoles(iamToken, folder.id, sa.id);

  let accessKey = cfg.yandex.saAccessKey;
  let secretKey = cfg.yandex.saSecretKey;
  if (accessKey === '' || secretKey === '') {
    const k = await mintAccessKey(iamToken, sa.id);
    accessKey = k.accessKey;
    secretKey = k.secret;
  } else {
    console.log('[bootstrap] reusing existing YANDEX_SA_* keys from env');
  }

  const bucket = await findOrCreateBucket(iamToken, folder.id, cfg.yandex.bucket);

  console.log('\n=== .env snippet — paste these into your .env ===');
  console.log(`YANDEX_FOLDER_ID=${folder.id}`);
  console.log(`YANDEX_BUCKET=${bucket}`);
  console.log(`YANDEX_SA_ACCESS_KEY=${accessKey}`);
  console.log(`YANDEX_SA_SECRET_KEY=${secretKey}`);
  console.log('=== end snippet ===\n');

  console.log('[bootstrap] summary (masked):');
  console.log({
    folderId: mask(folder.id),
    bucket,
    saAccessKey: mask(accessKey),
    saSecretKey: mask(secretKey),
  });
  console.log('[bootstrap] DONE');
}

main().catch((err) => {
  console.error('[bootstrap] FAILED');
  console.error((err as Error).message);
  process.exitCode = 1;
});
