/**
 * "Poster bilan solishtirish" — the bulk recipe audit (owner: every recipe
 * must match Poster). Built against:
 *   GET  /api/integrations/poster/recipe-audit          → { job, report, last_apply_report, restorable_job_id }
 *   GET  /api/integrations/poster/recipe-audit/job      → { job }   (polled while running)
 *   POST /api/integrations/poster/recipe-audit/run      → { job }
 *   POST /api/integrations/poster/recipe-audit/apply    → { job }   pm; { product_ids, include_stage_resets }
 *   POST /api/integrations/poster/recipe-audit/restore  → { job }   pm; { job_id }
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from '@/components/ui/toast';
import { AuthContext, type AuthContextValue } from '@/hooks/auth-context';
import { RoleRoute } from '@/routes/RoleRoute';
import { jsonResponse, renderWithProviders } from '@/test/render-helpers';
import type {
  RecipeAuditItem,
  RecipeAuditJob,
  RecipeAuditReport,
  RecipeAuditState,
  Role,
} from '@/lib/types';
import { RecipeAuditPage } from './RecipeAuditPage';
import { RECIPE_AUDIT_ROLES } from './recipeAuditAccess';

const API = '/api/integrations/poster/recipe-audit';
const JOB_API = `${API}/job`;
const APPLY_ALL = "Farqlilarni Poster'dan yangilash (qulflarni ochib)";
const RESTORE = 'Oxirgi ommaviy yangilashni bekor qilish';

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

function item(over: Partial<RecipeAuditItem> & Pick<RecipeAuditItem, 'product_id' | 'product_name' | 'status'>): RecipeAuditItem {
  return {
    product_type: 'semi',
    product_unit: 'kg',
    recipe_locked: false,
    poster_name: over.product_name,
    source: 'prepack',
    lines: [],
    not_found: [],
    warnings: [],
    stages_will_reset: false,
    ...over,
  };
}

/** Differs, locked, and its Hamir/Krem split would be lost. */
const MEDOVIK = item({
  product_id: 11,
  product_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ',
  status: 'differs',
  recipe_locked: true,
  stages_will_reset: true,
  lines: [
    { component_product_id: 21, component_name: 'з/г медовик', erp_qty: 1, poster_qty: null, stage: 'base', diff: 'erp_only' },
    { component_product_id: 22, component_name: 'медовик шок черный тесто', erp_qty: null, poster_qty: 0.1153, stage: null, diff: 'poster_only' },
    { component_product_id: 24, component_name: 'медовик крем', erp_qty: 0.06, poster_qty: 0.0639, stage: 'decoration', diff: 'changed' },
  ],
});
const KREM = item({
  product_id: 12,
  product_name: 'Krem asosi',
  status: 'match',
  lines: [{ component_product_id: 23, component_name: 'мука', erp_qty: 0.5, poster_qty: 0.5001, stage: 'base', diff: 'same' }],
});
const BISKVIT = item({
  product_id: 13,
  product_name: 'Biskvit',
  status: 'unresolved',
  recipe_locked: true,
  not_found: ['Kardamon'],
  lines: [{ component_product_id: null, component_name: 'Kardamon', erp_qty: null, poster_qty: 0.005, stage: null, diff: 'poster_only' }],
});
const ESKI = item({
  product_id: 14,
  product_name: 'Eski krem',
  status: 'poster_missing',
  recipe_locked: true,
  poster_name: null,
  source: null,
});
/** Differs, unlocked, keeps its stages. */
const CAKE = item({
  product_id: 15,
  product_name: 'Cake',
  product_type: 'finished',
  product_unit: 'pcs',
  status: 'differs',
  poster_name: 'Cake (menyu)',
  source: 'menu',
  lines: [{ component_product_id: 23, component_name: 'мука', erp_qty: 0.25, poster_qty: 0.2, stage: 'base', diff: 'changed' }],
});
/** Matches but is locked: applying only opens the lock. */
const QULFLI = item({ product_id: 16, product_name: 'Qulfli krem', status: 'match', recipe_locked: true });
const NAPOLEON = item({
  product_id: 17,
  product_name: 'Napoleon',
  status: 'poster_error',
  warnings: ['Poster API xatosi: menu.getProduct javob bermadi.'],
});

const REPORT: RecipeAuditReport = {
  generated_at: minutesAgo(1),
  summary: {
    total: 7, match: 2, differs: 2, locked: 4, poster_missing: 1, poster_error: 1,
    unresolved: 1, stages_will_reset: 1,
  },
  items: [MEDOVIK, KREM, BISKVIT, ESKI, CAKE, QULFLI, NAPOLEON],
};

function job(over: Partial<RecipeAuditJob> = {}): RecipeAuditJob {
  return {
    id: 'job-1',
    kind: 'audit',
    status: 'done',
    started_at: minutesAgo(2),
    finished_at: minutesAgo(1),
    progress: { done: 7, total: 7 },
    ...over,
  };
}
const running = (over: Partial<RecipeAuditJob> = {}) =>
  job({ status: 'running', finished_at: null, ...over });

function state(over: Partial<RecipeAuditState> = {}): RecipeAuditState {
  return { job: job(), report: REPORT, last_apply_report: null, restorable_job_id: null, ...over };
}
const EMPTY: RecipeAuditState = { job: null, report: null, last_apply_report: null, restorable_job_id: null };

interface Call {
  method: string;
  path: string;
  body: unknown;
}
let calls: Call[];

/**
 * Mocks fetch by `METHOD path`. An array answers with the next element on
 * each call (as JSON 200) and repeats the last one.
 */
function mockApi(routes: Record<string, (() => Response) | unknown[]>) {
  const cursors = new Map<string, number>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname;
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, path, body });
    const key = `${method} ${path}`;
    const route = routes[key];
    if (route === undefined) {
      return jsonResponse(500, { error: { code: 'TEST', message: `Unmocked ${key}` } });
    }
    if (typeof route === 'function') return route();
    const i = cursors.get(key) ?? 0;
    cursors.set(key, i + 1);
    return jsonResponse(200, route[Math.min(i, route.length - 1)]);
  });
}

const count = (method: string, path: string) =>
  calls.filter((c) => c.method === method && c.path === path).length;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Product names of the visible rows, in order. */
function rowNames(): string[] {
  return screen.queryAllByTestId('audit-row-name').map((el) => el.textContent ?? '');
}

/** The value under a summary tile label. */
function tile(label: string): string {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? '';
}

/** Filter pills are named "<label> <count>". */
const pill = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label} \\d+$`) });

function toasts(variant: 'success' | 'error' | 'warning'): string[] {
  return Array.from(document.querySelectorAll(`[data-variant="${variant}"] > span`)).map(
    (el) => el.textContent ?? '',
  );
}

function renderPage(role: Role = 'pm') {
  const user = userEvent.setup();
  const result = renderWithProviders(<RecipeAuditPage pollMs={10} />, { role, locationId: null, locations: [] });
  return { user, unmount: result.unmount };
}

beforeEach(() => {
  localStorage.setItem('adia.token', 'fake-jwt');
  calls = [];
});
afterEach(() => {
  localStorage.removeItem('adia.token');
  vi.restoreAllMocks();
});

// -----------------------------------------------------------------------------

describe('RecipeAuditPage — report', () => {
  it('shows the last report on open: summary counts and one row per product', async () => {
    mockApi({ [`GET ${API}`]: [state()] });
    renderPage();

    await screen.findByText('Biskvit');
    expect(tile('Jami')).toBe('7');
    expect(tile('Mos')).toBe('2');
    expect(tile('Farqli')).toBe('2');
    expect(tile('Qulflangan')).toBe('4');
    expect(tile("Bosqichlari yo'qoladi")).toBe('1');
    expect(tile("Poster'da yo'q")).toBe('1');
    expect(tile('Poster xatosi')).toBe('1');
    expect(tile('Topilmagan komponent')).toBe('1');
    // Differing recipes first.
    expect(rowNames().slice(0, 2).sort()).toEqual(['Cake', 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ']);
    expect(rowNames()).toHaveLength(7);
    // Not running: one read, no polling.
    await pause(40);
    expect(calls).toHaveLength(1);
  });

  it('run → polls /job only, then reads the full report once at the end', async () => {
    mockApi({
      [`GET ${API}`]: [EMPTY, state()],
      [`POST ${API}/run`]: () => jsonResponse(202, { job: running({ progress: { done: 0, total: 7 } }) }),
      [`GET ${JOB_API}`]: [
        { job: running({ progress: { done: 3, total: 7 } }) },
        { job: running({ progress: { done: 5, total: 7 } }) },
        { job: job() },
      ],
    });
    const { user } = renderPage('production_manager');

    expect(await screen.findByText(/Hali tekshiruv o'tkazilmagan/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tekshirishni boshlash' }));

    expect(calls).toContainEqual({ method: 'POST', path: `${API}/run`, body: {} });
    expect(await screen.findByText('3 / 7')).toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '3');
    expect(screen.getByRole('button', { name: 'Tekshirishni boshlash' })).toBeDisabled();

    expect(await screen.findByText('Biskvit')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(toasts('warning').join(' ')).toContain('2 tasi farqli');
    // Polling used the light endpoint; the full state was read on open + once at the end.
    expect(count('GET', JOB_API)).toBe(3);
    expect(count('GET', API)).toBe(2);
    await pause(60);
    expect(count('GET', JOB_API)).toBe(3);
    expect(count('GET', API)).toBe(2);
  });

  it('stops polling on unmount — no request afterwards', async () => {
    mockApi({
      [`GET ${API}`]: [state({ job: running({ progress: { done: 1, total: 7 } }) })],
      [`GET ${JOB_API}`]: [{ job: running({ progress: { done: 2, total: 7 } }) }],
    });
    const { unmount } = renderPage();

    await waitFor(() => expect(count('GET', JOB_API)).toBeGreaterThanOrEqual(2));
    unmount();
    const after = calls.length;
    await pause(80);
    expect(calls.length).toBe(after);
  });

  it('a 409 on run (hourly Poster sync holds the lock) shows the message', async () => {
    const message = "Poster sinxronlash ishlayapti — bir necha daqiqadan keyin qayta urinib ko'ring.";
    mockApi({
      [`GET ${API}`]: [state()],
      [`POST ${API}/run`]: () => jsonResponse(409, { error: { code: 'CONFLICT', message } }),
    });
    const { user } = renderPage();
    await screen.findByText('Biskvit');

    await user.click(screen.getByRole('button', { name: 'Tekshirishni boshlash' }));

    await waitFor(() => expect(toasts('error')).toContain(message));
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('button', { name: 'Tekshirishni boshlash' })).toBeEnabled();
  });

  it('filters by status / lock / stage loss / Poster error, and searches by name', async () => {
    mockApi({ [`GET ${API}`]: [state()] });
    const { user } = renderPage();
    await screen.findByText('Biskvit');

    await user.click(pill('Farqli'));
    expect(rowNames().sort()).toEqual(['Cake', 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ']);
    expect(pill('Farqli')).toHaveAttribute('aria-pressed', 'true');

    await user.click(pill('Qulflangan'));
    expect(rowNames().sort()).toEqual(['Biskvit', 'Eski krem', 'Qulfli krem', 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ']);

    await user.click(pill("Bosqichlari yo'qoladi"));
    expect(rowNames()).toEqual(['Г/П МЕДОВИК ШОК ЧЕРНЫЙ']);

    await user.click(pill('Topilmagan'));
    expect(rowNames()).toEqual(['Biskvit']);

    await user.click(pill("Poster'da yo'q"));
    expect(rowNames()).toEqual(['Eski krem']);

    await user.click(pill('Poster xatosi'));
    expect(rowNames()).toEqual(['Napoleon']);

    await user.click(pill('Hammasi'));
    await user.type(screen.getByRole('searchbox', { name: /qidirish/i }), 'medovik');
    expect(rowNames()).toEqual(['Г/П МЕДОВИК ШОК ЧЕРНЫЙ']);
  });

  it('flags stage loss on the row, and the line diff shows each ERP stage', async () => {
    mockApi({ [`GET ${API}`]: [state()] });
    const { user } = renderPage();
    await screen.findByText('Biskvit');

    // Only the recipe whose split would be lost carries the badge.
    expect(screen.getAllByText("Bosqichlar yo'qoladi")).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /Г\/П МЕДОВИК/ }));
    const diff = screen.getByRole('table', { name: /МЕДОВИК/ });
    expect(within(diff).getByRole('columnheader', { name: 'Bosqich' })).toBeInTheDocument();
    const hamir = within(diff).getByText('з/г медовик').closest('tr') as HTMLElement;
    expect(hamir).toHaveAttribute('data-diff', 'erp_only');
    expect(within(hamir).getByText('Hamir')).toBeInTheDocument();
    const krem = within(diff).getByText('медовик крем').closest('tr') as HTMLElement;
    expect(krem).toHaveAttribute('data-diff', 'changed');
    expect(within(krem).getByText('Krem')).toBeInTheDocument();
    expect(within(krem).getByText('0,06')).toBeInTheDocument();
    expect(within(krem).getByText('0,0639')).toBeInTheDocument();
    expect(within(krem).getByText('+0,0039')).toBeInTheDocument();
    expect(within(diff).getByText("faqat Poster'da")).toBeInTheDocument();
    expect(screen.getByText(/zagatovka\s+jarayoni bosqichlar qayta belgilanmaguncha ishlamaydi/)).toBeInTheDocument();
    // The hourly sync skips such recipes (backend R6): this page is where they get fixed.
    expect(screen.getByText(/Soatlik Poster sinxronlash bu\s+retseptni o'zgartirmaydi/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Cake/ }));
    const cake = screen.getByRole('table', { name: /Cake/ });
    expect(within(cake).getByText(/^[−-]0,05$/)).toBeInTheDocument();
  });

  it('labels Poster errors, Г/П (gp) products and row warnings', async () => {
    const gp = item({ product_id: 18, product_name: 'Г/П Эклер', product_type: 'gp', status: 'match' });
    mockApi({ [`GET ${API}`]: [state({ report: { ...REPORT, items: [NAPOLEON, gp] } })] });
    const { user } = renderPage();

    await screen.findByText('Napoleon');
    expect(screen.getByText('Poster xatosi', { selector: 'td *' })).toBeInTheDocument();
    expect(screen.getByText('Готовая продукция')).toBeInTheDocument();
    expect(screen.getByText('1 ta ogohlantirish')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Napoleon/ }));
    expect(screen.getByText('Poster API xatosi: menu.getProduct javob bermadi.')).toBeInTheDocument();
  });

  it('a failed job shows its error', async () => {
    const error = "Poster bilan bog'lanib bo'lmadi. Keyinroq qayta urinib ko'ring.";
    mockApi({ [`GET ${API}`]: [{ ...EMPTY, job: job({ status: 'failed', error }) }] });
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('muvaffaqiyatsiz');
    expect(alert).toHaveTextContent(error);
  });

  it('a failed first load shows an error with retry', async () => {
    mockApi({
      [`GET ${API}`]: () => jsonResponse(403, { error: { code: 'FORBIDDEN', message: 'Ruxsat yo‘q.' } }),
    });
    renderPage();

    expect(await screen.findByText('Ruxsat yo‘q.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Qayta urinish' })).toBeInTheDocument();
  });

  it('never shows more than 100% while the total is still growing', async () => {
    mockApi({
      [`GET ${API}`]: [{ ...EMPTY, job: running({ kind: 'apply', progress: { done: 9, total: 7 } }) }],
      [`GET ${JOB_API}`]: [{ job: running({ kind: 'apply', progress: { done: 9, total: 7 } }) }],
    });
    renderPage();

    const bar = await screen.findByRole('progressbar');
    expect(bar).toHaveAttribute('aria-valuenow', '7');
    expect(bar).toHaveAttribute('aria-valuemax', '7');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('100%');
  });
});

// -----------------------------------------------------------------------------

describe('RecipeAuditPage — bulk apply', () => {
  const started = () => jsonResponse(202, { job: running({ id: 'job-2', kind: 'apply' }) });

  it('"all": split confirm; stage-reset recipes left out by default (explicit ids)', async () => {
    mockApi({ [`GET ${API}`]: [state()], [`POST ${API}/apply`]: started });
    const { user } = renderPage('pm');
    await screen.findByText('Biskvit');

    await user.click(screen.getByRole('button', { name: APPLY_ALL }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Hisobot vaqti:');
    expect(dialog).toHaveTextContent("1 ta farqli retsept Poster'dagi bilan almashtiriladi va qulflari ochiladi.");
    expect(dialog).toHaveTextContent('1 ta mos lekin qulflangan retseptning qulfi ochiladi');
    expect(dialog).toHaveTextContent(
      "1 ta retseptda Hamir/Krem/Bezak bo'linishi yo'qoladi — bu tortlar uchun zagatovka jarayoni bosqichlar qayta belgilanmaguncha ishlamaydi.",
    );
    const include = within(dialog).getByRole('checkbox', { name: "Bosqichlari yo'qoladigan 1 ta retseptni ham yangilash" });
    expect(include).not.toBeChecked();
    expect(dialog).toHaveTextContent("Belgilanmagan: bu 1 ta retsept o'tkazib yuboriladi va qulfi qoladi.");
    expect(dialog).toHaveTextContent('Jami yangilanadi: 2 ta retsept.');
    // A fresh report: no advice to re-check.
    expect(dialog).not.toHaveTextContent('10 daqiqadan eski');
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    await user.click(within(dialog).getByRole('button', { name: 'Ha, yangilash' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `${API}/apply`,
        body: { product_ids: [15, 16], include_stage_resets: false },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('ticking the box includes the stage-reset recipes', async () => {
    mockApi({ [`GET ${API}`]: [state()], [`POST ${API}/apply`]: started });
    const { user } = renderPage('pm');
    await screen.findByText('Biskvit');

    await user.click(screen.getByRole('button', { name: APPLY_ALL }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: /Bosqichlari yo'qoladigan/ }));
    expect(dialog).toHaveTextContent("Bu 1 ta retsept ham Poster'dagi bilan almashtiriladi va qulfi ochiladi");
    expect(dialog).toHaveTextContent('Jami yangilanadi: 3 ta retsept.');

    await user.click(within(dialog).getByRole('button', { name: 'Ha, yangilash' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `${API}/apply`,
        body: { product_ids: [15, 16, 11], include_stage_resets: true },
      }),
    );
  });

  it('a locked match whose stages would change is never counted as "lock only"', async () => {
    const lockedStages = item({ product_id: 19, product_name: 'Qulfli tort', status: 'match', recipe_locked: true, stages_will_reset: true });
    mockApi({
      [`GET ${API}`]: [state({ report: { ...REPORT, items: [QULFLI, lockedStages] } })],
      [`POST ${API}/apply`]: started,
    });
    const { user } = renderPage('pm');
    await screen.findByText('Qulfli tort');

    await user.click(screen.getByRole('button', { name: APPLY_ALL }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('1 ta mos lekin qulflangan retseptning qulfi ochiladi');
    expect(dialog).not.toHaveTextContent('2 ta mos lekin qulflangan');
    expect(dialog).toHaveTextContent("1 ta retseptda Hamir/Krem/Bezak bo'linishi yo'qoladi");
    expect(dialog).not.toHaveTextContent('farqli retsept');
  });

  it('an old report: shows its time and suggests re-checking first', async () => {
    mockApi({
      [`GET ${API}`]: [state({ report: { ...REPORT, generated_at: minutesAgo(45) } })],
      [`POST ${API}/apply`]: started,
    });
    const { user } = renderPage('pm');
    await screen.findByText('Biskvit');

    await user.click(screen.getByRole('button', { name: APPLY_ALL }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Hisobot 10 daqiqadan eski');
  });

  it('selected rows only → their ids (stage resets still opt-in)', async () => {
    mockApi({ [`GET ${API}`]: [state()], [`POST ${API}/apply`]: started });
    const { user } = renderPage('pm');
    await screen.findByText('Biskvit');

    // Only targets are selectable.
    for (const name of [/Biskvit/, /Eski krem/, /Napoleon/, /Krem asosi/]) {
      expect(screen.queryByRole('checkbox', { name })).toBeNull();
    }
    await user.click(screen.getByRole('checkbox', { name: /Cake/ }));
    await user.click(screen.getByRole('checkbox', { name: /МЕДОВИК/ }));
    await user.click(screen.getByRole('button', { name: 'Tanlanganlarni yangilash (2)' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Jami yangilanadi: 1 ta retsept.');
    await user.click(screen.getByRole('button', { name: 'Ha, yangilash' }));

    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: `${API}/apply`,
        body: { product_ids: [15], include_stage_resets: false },
      }),
    );
  });

  it('after the job: the apply outcome has its own view, reasons grouped, and survives a later dry run', async () => {
    const changed = "Holati o'zgargan — qayta tekshiring";
    const busy = 'Mahsulot band — ishlab chiqarish buyurtmasi ochiq';
    const applyReport: RecipeAuditReport = {
      generated_at: minutesAgo(0),
      summary: { ...REPORT.summary, applied: 1, skipped: 3 },
      items: [
        { ...CAKE, status: 'match', apply_result: 'applied' },
        { ...QULFLI, apply_result: 'skipped', apply_message: changed },
        { ...MEDOVIK, apply_result: 'skipped', apply_message: changed },
        { ...KREM, recipe_locked: true, apply_result: 'failed', apply_message: busy },
      ],
    };
    const after = state({
      job: job({ id: 'job-2', kind: 'apply' }),
      last_apply_report: applyReport,
      restorable_job_id: 'job-2',
    });
    mockApi({
      [`GET ${API}`]: [state(), after],
      [`POST ${API}/apply`]: started,
      [`GET ${JOB_API}`]: [{ job: running({ id: 'job-2', kind: 'apply' }) }, { job: job({ id: 'job-2', kind: 'apply' }) }],
    });
    const { user } = renderPage('pm');
    await screen.findByText('Biskvit');

    await user.click(screen.getByRole('button', { name: APPLY_ALL }));
    await user.click(screen.getByRole('button', { name: 'Ha, yangilash' }));

    const applyTab = await screen.findByRole('tab', { name: 'Oxirgi yangilash natijasi' });
    await waitFor(() => expect(applyTab).toHaveAttribute('aria-selected', 'true'));
    expect(tile('Yangilandi')).toBe('1');
    expect(tile('Yangilanmadi')).toBe('3');
    expect(toasts('warning').join(' ')).toContain('3 tasi yangilanmadi');

    // Reasons, most frequent first, with counts.
    const reasons = screen.getByRole('heading', { name: 'Yangilanmaganlar sabablari' }).closest('div') as HTMLElement;
    const lines = within(reasons).getAllByRole('listitem').map((li) => li.textContent);
    expect(lines).toEqual([`${changed}2 ta`, `${busy}1 ta`]);

    await user.click(pill('Yangilanmagan'));
    expect(rowNames().sort()).toEqual(['Krem asosi', 'Qulfli krem', 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ']);
    expect(screen.getByText('Xato', { selector: 'td *' })).toBeInTheDocument();

    // The latest dry run is one tab away; the outcome is still there after.
    await user.click(screen.getByRole('tab', { name: 'Solishtirish' }));
    expect(await screen.findByText('Biskvit')).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Oxirgi yangilash natijasi' }));
    expect(tile('Yangilandi')).toBe('1');
    // The full report was read once more, at the end of the job.
    expect(count('GET', API)).toBe(2);
  });

  it('409 (another job or the Poster sync running): shows the message and picks up the running job', async () => {
    const message = 'Boshqa tekshiruv yoki yangilash hozir ishlayapti.';
    const other = running({ id: 'job-9', progress: { done: 12, total: 30 } });
    mockApi({
      [`GET ${API}`]: [state(), state({ job: other })],
      [`GET ${JOB_API}`]: [{ job: other }],
      [`POST ${API}/apply`]: () => jsonResponse(409, { error: { code: 'CONFLICT', message } }),
    });
    const { user } = renderPage('pm');
    await screen.findByText('Biskvit');

    await user.click(screen.getByRole('button', { name: APPLY_ALL }));
    await user.click(screen.getByRole('button', { name: 'Ha, yangilash' }));

    await waitFor(() => expect(toasts('error')).toContain(message));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('12 / 30')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: APPLY_ALL })).toBeDisabled();
  });

  it('422: the dialog stays open with the reason', async () => {
    const message = 'Tanlangan mahsulotlar yangilash doirasida emas: 13.';
    mockApi({
      [`GET ${API}`]: [state()],
      [`POST ${API}/apply`]: () => jsonResponse(422, { error: { code: 'VALIDATION_ERROR', message } }),
    });
    const { user } = renderPage('pm');
    await screen.findByText('Biskvit');

    await user.click(screen.getByRole('button', { name: APPLY_ALL }));
    await user.click(screen.getByRole('button', { name: 'Ha, yangilash' }));

    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(message);
    expect(within(dialog).getByRole('button', { name: 'Ha, yangilash' })).toBeEnabled();
  });

  it('production_manager can run the audit but sees no apply or restore controls', async () => {
    mockApi({ [`GET ${API}`]: [state({ restorable_job_id: 'job-2' })] });
    renderPage('production_manager');
    await screen.findByText('Biskvit');

    expect(screen.getByRole('button', { name: 'Tekshirishni boshlash' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: APPLY_ALL })).toBeNull();
    expect(screen.queryByRole('button', { name: /Tanlanganlarni yangilash/ })).toBeNull();
    expect(screen.queryByRole('button', { name: RESTORE })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------

describe('RecipeAuditPage — restore', () => {
  it('pm: confirm → POST restore { job_id } → "Tiklandi" badges', async () => {
    const applyReport: RecipeAuditReport = {
      generated_at: minutesAgo(5),
      summary: { ...REPORT.summary, applied: 1, skipped: 0 },
      items: [{ ...CAKE, apply_result: 'applied' }],
    };
    const restoredReport: RecipeAuditReport = {
      ...applyReport,
      items: [{ ...CAKE, apply_result: 'restored' }],
    };
    mockApi({
      [`GET ${API}`]: [
        state({ last_apply_report: applyReport, restorable_job_id: 'job-2' }),
        state({ job: job({ id: 'job-3', kind: 'restore' }), last_apply_report: restoredReport }),
      ],
      [`POST ${API}/restore`]: () =>
        jsonResponse(202, { job: running({ id: 'job-3', kind: 'restore' }) }),
      [`GET ${JOB_API}`]: [{ job: job({ id: 'job-3', kind: 'restore' }) }],
    });
    const { user } = renderPage('pm');
    await screen.findByText('Biskvit');

    await user.click(screen.getByRole('button', { name: RESTORE }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent(
      "Oxirgi ommaviy yangilashda o'zgargan 1 ta retsept va ularning qulflari o'sha yangilashdan oldingi holatiga qaytariladi",
    );
    // What "back to before" means for each lock state.
    expect(dialog).toHaveTextContent(
      "O'sha yangilashdan oldin qulfsiz bo'lgan retseptlar qulfsiz qaytadi — soatlik Poster sinxronlash ularni yana yangilashi mumkin.",
    );
    expect(dialog).toHaveTextContent("Qulflangan bo'lgan retseptlar qulflangan holda qaytadi.");
    await user.click(within(dialog).getByRole('button', { name: 'Ha, bekor qilish' }));

    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'POST', path: `${API}/restore`, body: { job_id: 'job-2' } }),
    );
    expect(await screen.findByText('Tiklandi', { selector: 'td *' })).toBeInTheDocument();
    expect(toasts('success').join(' ')).toContain('1 ta retsept tiklandi');
    expect(screen.getByRole('tab', { name: 'Oxirgi yangilash natijasi' })).toHaveAttribute('aria-selected', 'true');
    // Nothing left to restore.
    expect(screen.queryByRole('button', { name: RESTORE })).toBeNull();
  });

  it('a restore whose final audit failed: counts from summary, the warning shown, not a failure', async () => {
    const note = 'Yakuniy tekshiruv bajarilmadi: Poster javob bermadi. Qayta tekshiring.';
    const applyReport: RecipeAuditReport = {
      generated_at: minutesAgo(5),
      summary: { ...REPORT.summary, applied: 2, skipped: 0 },
      items: [{ ...CAKE, apply_result: 'applied' }, { ...QULFLI, apply_result: 'applied' }],
    };
    const restoredNoItems: RecipeAuditReport = {
      generated_at: minutesAgo(0),
      summary: { ...REPORT.summary, applied: 0, skipped: 0, restored: 2 },
      items: [],
      warnings: [note],
    };
    mockApi({
      [`GET ${API}`]: [
        state({ last_apply_report: applyReport, restorable_job_id: 'job-2' }),
        state({ job: job({ id: 'job-3', kind: 'restore' }), last_apply_report: restoredNoItems }),
      ],
      [`POST ${API}/restore`]: () =>
        jsonResponse(202, { job: running({ id: 'job-3', kind: 'restore' }) }),
      [`GET ${JOB_API}`]: [{ job: job({ id: 'job-3', kind: 'restore' }) }],
    });
    const { user } = renderPage('pm');
    await screen.findByText('Biskvit');

    await user.click(screen.getByRole('button', { name: RESTORE }));
    await user.click(screen.getByRole('button', { name: 'Ha, bekor qilish' }));

    expect(await screen.findByText('Tiklandi', { selector: 'dt' })).toBeInTheDocument();
    expect(tile('Tiklandi')).toBe('2');
    expect(screen.queryByText('Yangilandi', { selector: 'dt' })).toBeNull();
    expect(screen.getByText(note, { selector: 'li' })).toBeInTheDocument();
    expect(screen.getByText(/batafsil ro'yxat yo'q/)).toBeInTheDocument();
    // The job is 'done': no failure banner, a warning toast rather than an error.
    expect(screen.queryByText(/muvaffaqiyatsiz/)).toBeNull();
    expect(toasts('error')).toHaveLength(0);
    expect(toasts('warning').join(' ')).toContain('2 ta retsept tiklandi');
  });
});

describe('RecipeAuditPage — apply outcome counts', () => {
  async function openOutcome(lastApply: RecipeAuditReport) {
    mockApi({ [`GET ${API}`]: [state({ last_apply_report: lastApply })] });
    const { user } = renderPage('pm');
    await user.click(await screen.findByRole('tab', { name: 'Oxirgi yangilash natijasi' }));
  }

  it.each([
    ['summary.restored present', { applied: 0, skipped: 0, restored: 1 }],
    ['older shape (applied included restores)', { applied: 1, skipped: 0 }],
  ])('%s → "Tiklandi 1" with no double-counted "Yangilandi"', async (_label, counts) => {
    await openOutcome({
      generated_at: minutesAgo(1),
      summary: { ...REPORT.summary, ...counts },
      items: [{ ...CAKE, apply_result: 'restored' }],
    });

    expect(tile('Tiklandi')).toBe('1');
    expect(screen.queryByText('Yangilandi', { selector: 'dt' })).toBeNull();
  });

  it('lists out-of-scope skips so the skipped count adds up', async () => {
    const changed = "Holati o'zgargan — qayta tekshiring";
    await openOutcome({
      generated_at: minutesAgo(1),
      summary: { ...REPORT.summary, applied: 1, skipped: 2 },
      items: [
        { ...CAKE, apply_result: 'applied' },
        { ...QULFLI, apply_result: 'skipped', apply_message: changed },
      ],
      skipped_outside_scope: [{ product_id: 99, apply_message: changed }],
    });

    expect(tile('Yangilanmadi')).toBe('2');
    expect(screen.getByText(`Doiradan tashqari: #99 — ${changed}`)).toBeInTheDocument();
    const reasons = screen.getByRole('heading', { name: 'Yangilanmaganlar sabablari' }).closest('div') as HTMLElement;
    expect(within(reasons).getAllByRole('listitem').map((li) => li.textContent)).toEqual([`${changed}2 ta`]);
  });
});

// -----------------------------------------------------------------------------

describe('RecipeAuditPage — access', () => {
  function renderRoute(role: Role) {
    const auth: AuthContextValue = {
      user: { id: 1, name: 'Test', username: 't', role, location_id: null },
      token: 'test-token',
      isAuthenticated: true,
      isHydrating: false,
      locations: [],
      allowedPaths: [],
      activeLocationId: null,
      login: () => {},
      logout: async () => {},
      setActiveLocation: async () => {},
    };
    render(
      <AuthContext.Provider value={auth}>
        <ToastProvider>
          <MemoryRouter initialEntries={['/products/recipe-audit']}>
            <Routes>
              <Route
                path="/products/recipe-audit"
                element={
                  <RoleRoute allow={RECIPE_AUDIT_ROLES}>
                    <RecipeAuditPage pollMs={10} />
                  </RoleRoute>
                }
              />
              <Route path="/dashboard" element={<p>Boshqaruv paneli</p>} />
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </AuthContext.Provider>,
    );
  }

  it.each<Role>(['store_manager', 'raw_warehouse_manager', 'central_warehouse_manager'])(
    '%s is sent away from the view',
    async (role) => {
      mockApi({ [`GET ${API}`]: [state()] });
      renderRoute(role);
      expect(await screen.findByText('Boshqaruv paneli')).toBeInTheDocument();
      expect(calls).toHaveLength(0);
    },
  );
});
