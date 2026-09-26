/**
 * Regression — RecipeDialog must parse the wrapped response shape.
 *
 * `GET /api/products/:id/recipe` returns `{ product_id, recipe: [...] }`
 * (apps/backend/src/routes/products.ts, asserted by apps/backend/test/products.test.ts
 * with `res.body.recipe`). The dialog calls
 * `apiRequest<RecipeLine[]>(...)` and then `.map(...)`'s the result —
 * which throws on the wrapped object and renders the toast
 * "Retseptni yuklab bo‘lmadi."
 *
 * The Prove-It pattern: this test FAILS today and stays as the
 * regression guard once the dialog reads `result.recipe`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ToastProvider } from '@/components/ui/toast';
import { RecipeDialog } from './RecipeDialog';
import { jsonResponse } from '@/test/render-helpers';
import type { Product } from '@/lib/types';

const FLOUR: Product = {
  id: 1,
  name: 'Un (oliy nav)',
  type: 'raw',
  unit: 'kg',
  sku: 'RAW-FLOUR',
  poster_product_id: null,
  poster_ingredient_id: null,
  is_active: true,
};

const CAKE: Product = {
  id: 5,
  name: 'Shokoladli tort',
  type: 'finished',
  unit: 'pcs',
  sku: 'FIN-CHOCO-CAKE',
  poster_product_id: null,
  poster_ingredient_id: null,
  is_active: true,
};

describe('RecipeDialog — wrapped recipe envelope', () => {
  beforeEach(() => {
    localStorage.setItem('adia.token', 'fake-jwt');
  });
  afterEach(() => {
    localStorage.removeItem('adia.token');
    vi.restoreAllMocks();
  });

  it('renders the BOM line from `{ product_id, recipe: [...] }` (spec §4.3)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonResponse(200, {
        product_id: 5,
        recipe: [
          { id: 1, product_id: 5, component_product_id: 1, qty_per_unit: '0.5000' },
        ],
      }),
    );

    await act(async () => {
      render(
        <ToastProvider>
          <RecipeDialog
            open
            onOpenChange={() => {}}
            product={CAKE}
            allProducts={[FLOUR, CAKE]}
            canEdit={false}
          />
        </ToastProvider>,
      );
    });

    // The error toast must NOT show; the loaded line must.
    await waitFor(() => {
      expect(screen.queryByText(/Retseptni yuklab bo/i)).toBeNull();
    });
    // The flour component must appear (either in a row label or select).
    expect(screen.getByText(/Un \(oliy nav\)/)).toBeTruthy();
  });
});

/**
 * Poster resync. A hand-saved recipe is locked, so the hourly sync skips it;
 * "Qulfni ochish" used to only flip the flag and "Posterdan yuklash" reported
 * an empty or partial result as a success — both looked like "nothing
 * happened". Unlocking now replaces the recipe with Poster's straight away
 * (POST …/apply), and the preview reports failures as failures.
 */
describe('RecipeDialog — Poster resync', () => {
  const SUGAR: Product = {
    id: 2,
    name: 'Shakar',
    type: 'raw',
    unit: 'kg',
    sku: 'RAW-SUGAR',
    poster_product_id: null,
    poster_ingredient_id: null,
    is_active: true,
  };
  const DOUGH: Product = {
    id: 3,
    name: 'Medovik testo',
    type: 'semi',
    unit: 'kg',
    sku: 'SEMI-DOUGH',
    poster_product_id: null,
    poster_ingredient_id: null,
    is_active: true,
  };
  const NAPOLEON: Product = {
    id: 6,
    name: 'Napoleon',
    type: 'finished',
    unit: 'pcs',
    sku: 'FIN-NAPOLEON',
    poster_product_id: null,
    poster_ingredient_id: null,
    is_active: true,
    recipe_locked: true,
  };
  const LOCKED_CAKE: Product = { ...CAKE, recipe_locked: true };
  const UNLOCKED_CAKE: Product = { ...CAKE, recipe_locked: false };

  const LOCK_BUTTON = "Qulfni ochish va Poster'dan yangilash";
  const REFRESH_BUTTON = "Poster'dan hozir yangilash";

  const recipePath = (id: number) => `/api/products/${id}/recipe`;
  const previewPath = (id: number) => `/api/integrations/poster/product-recipe/${id}`;
  const applyPath = (id: number) => `/api/integrations/poster/product-recipe/${id}/apply`;

  /** GET recipe without `recipe_locked` — the dialog falls back to the prop. */
  const STORED_RECIPE = {
    product_id: 5,
    recipe: [
      { id: 1, product_id: 5, component_product_id: 1, qty_per_unit: '0.5000', brutto: '0.5000', stage: 'base' },
    ],
  };
  const DOUGH_ONLY_RECIPE = {
    product_id: 5,
    recipe_locked: true,
    recipe: [
      { id: 7, product_id: 5, component_product_id: 3, qty_per_unit: 0.4, brutto: 0.4, stage: 'base' },
    ],
  };

  const APPLY_RESULT = {
    product_id: 5,
    recipe_locked: false,
    source: 'prepack',
    poster_product_id: 1234,
    poster_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ',
    recipe: [
      {
        id: 10, product_id: 5, component_product_id: 2, qty_per_unit: 0.1153, brutto: 0.1153,
        stage: 'base', component_name: 'Shakar', component_unit: 'kg', component_cost_price: 16071,
        component_type: 'raw',
      },
      {
        id: 11, product_id: 5, component_product_id: 3, qty_per_unit: 0.25, brutto: 0.3,
        stage: 'decoration', component_name: 'Medovik testo', component_unit: 'kg',
        component_cost_price: null, component_type: 'semi',
      },
    ],
    warnings: [] as string[],
  };
  const STAGE_WARNING =
    "Poster tarkibi o'zgargani uchun Hamir/Krem/Bezak bosqichlari tiklanmadi — kerak bo'lsa qayta belgilang.";
  const MERGE_WARNING = "Poster'da 'Shakar' ikki marta bor edi — bitta qatorga birlashtirildi.";
  const APPLY_WITH_WARNINGS = { ...APPLY_RESULT, warnings: [STAGE_WARNING, MERGE_WARNING] };

  const PREVIEW_SUGAR_LINE = {
    component_product_id: 2,
    component_name: 'Shakar',
    component_unit: 'kg',
    qty_per_unit: 0.1153,
    brutto: 0.1153,
    found: true,
  };

  type Handler = () => Response | Promise<Response>;
  let calls: string[];

  /** Routes the mocked fetch by pathname and records `METHOD path` per call. */
  function mockApi(routes: Record<string, Handler>) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const raw =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, 'http://localhost').pathname;
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      const handler = routes[path];
      if (!handler) {
        return jsonResponse(500, { error: { code: 'TEST', message: `Unmocked ${path}` } });
      }
      return handler();
    });
  }

  /** A response the test releases by hand, to hold a request in flight. */
  function deferred() {
    let resolve: (res: Response) => void = () => {};
    const promise = new Promise<Response>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  /**
   * Lets a released response run to completion: `Response.text()` resolves on
   * a later tick than `act` flushes, so a "nothing changed" assertion made
   * straight after `resolve()` would pass without the response being handled.
   */
  async function settle() {
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
  }

  /**
   * Toast messages by variant. Toasts render outside the modal, which Radix
   * hides from the accessibility tree, so read them from the DOM.
   */
  function toasts(variant: 'success' | 'error' | 'warning'): string[] {
    return Array.from(document.querySelectorAll(`[data-variant="${variant}"] > span`)).map(
      (el) => el.textContent ?? '',
    );
  }

  async function renderDialog(product: Product, firstComponent = 'Un (oliy nav)') {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    const user = userEvent.setup();
    const ui = (props: { product: Product | null; open: boolean }) => (
      <ToastProvider>
        <RecipeDialog
          open={props.open}
          onOpenChange={onOpenChange}
          product={props.product}
          allProducts={[FLOUR, SUGAR, DOUGH, CAKE, NAPOLEON]}
          canEdit
          onSaved={onSaved}
        />
      </ToastProvider>
    );
    const { rerender } = render(ui({ product, open: true }));
    // The stored recipe is on screen before any Poster action.
    await screen.findByDisplayValue(firstComponent);
    return {
      onSaved,
      onOpenChange,
      user,
      /** Re-render as ProductsPage does: close = `product: null, open: false`. */
      rerenderWith: (props: { product: Product | null; open: boolean }) => rerender(ui(props)),
    };
  }

  /**
   * Opens the inline apply confirm and waits for its stage pre-check (the
   * preview GET) to settle — "Ha" is disabled until then.
   */
  async function openConfirm(
    user: ReturnType<typeof userEvent.setup>,
    trigger: string,
  ): Promise<HTMLElement> {
    await user.click(screen.getByRole('button', { name: trigger }));
    const confirm = screen.getByRole('button', { name: 'Ha, yangilash' });
    await waitFor(() => expect(confirm).toBeEnabled());
    return confirm;
  }

  beforeEach(() => {
    localStorage.setItem('adia.token', 'fake-jwt');
    calls = [];
  });
  afterEach(() => {
    localStorage.removeItem('adia.token');
    vi.restoreAllMocks();
  });

  describe('stage pre-check before apply', () => {
    it('warns that Hamir/Krem/Bezak will be lost, with "Ha" held until the check answers', async () => {
      const preview = deferred();
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [previewPath(5)]: () => preview.promise,
      });
      const { user } = await renderDialog(LOCKED_CAKE);

      await user.click(screen.getByRole('button', { name: LOCK_BUTTON }));
      expect(screen.getByText('Bosqichlar tekshirilmoqda…')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Ha, yangilash' })).toBeDisabled();
      expect(screen.getByRole('button', { name: "Yo'q" })).toHaveFocus();

      await act(async () => {
        preview.resolve(
          jsonResponse(200, { lines: [PREVIEW_SUGAR_LINE], not_found: [], stages_will_reset: true }),
        );
      });

      expect(
        await screen.findByText(/Hamir\/Krem\/Bezak bo'linishi yo'qoladi/),
      ).toBeInTheDocument();
      await waitFor(() => expect(screen.getByRole('button', { name: 'Ha, yangilash' })).toBeEnabled());
      expect(screen.getByRole('button', { name: 'Ha, yangilash' })).toHaveFocus();
      expect(calls).not.toContain(`POST ${applyPath(5)}`);
    });

    it('no warning when the split is kept', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [previewPath(5)]: () =>
          jsonResponse(200, { lines: [PREVIEW_SUGAR_LINE], not_found: [], stages_will_reset: false }),
      });
      const { user } = await renderDialog(LOCKED_CAKE);

      await openConfirm(user, LOCK_BUTTON);
      expect(screen.queryByText(/bo'linishi yo'qoladi/)).toBeNull();
    });
  });

  describe('apply (unlock / refresh from Poster)', () => {
    it('unlock → confirm → POST apply, shows Poster components and "Qulfsiz"', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [applyPath(5)]: () => jsonResponse(200, APPLY_RESULT),
      });
      const { onSaved, user } = await renderDialog(LOCKED_CAKE);
      expect(screen.getByText('Qulflangan')).toBeInTheDocument();

      const confirm = await openConfirm(user, LOCK_BUTTON);
      // Replacing the recipe is destructive: nothing is sent before "Ha".
      expect(calls).not.toContain(`POST ${applyPath(5)}`);
      expect(
        screen.getByText(/almashtiriladi va qulf ochiladi\. Davom etasizmi\?/),
      ).toBeInTheDocument();
      // Focus lands on "Ha" once the stage pre-check has finished.
      await waitFor(() => expect(confirm).toHaveFocus());

      await user.click(confirm);

      expect(await screen.findByText('Qulfsiz')).toBeInTheDocument();
      expect(calls).toContain(`POST ${applyPath(5)}`);
      // The table now holds Poster's components, not the stored one.
      expect(screen.getByDisplayValue('Shakar')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Medovik testo')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('Un (oliy nav)')).toBeNull();
      expect(screen.getAllByDisplayValue('0.1153')).toHaveLength(2); // brutto + netto
      expect(screen.getByDisplayValue('0.3')).toBeInTheDocument();
      expect(screen.getByDisplayValue('0.25')).toBeInTheDocument();

      // The toast names the product (another dialog may be open by then).
      expect(toasts('success')).toEqual([
        '"Shokoladli tort" retsepti Poster\'dan yangilandi: 2 ta komponent. Qulf ochildi.',
      ]);
      expect(toasts('warning')).toHaveLength(0);
      expect(onSaved).toHaveBeenCalledTimes(1);
      // Once unlocked, the box offers an on-demand refresh instead — and keyboard
      // focus is back on it rather than lost with the confirm step.
      expect(screen.getByRole('button', { name: REFRESH_BUTTON })).toHaveFocus();
    });

    it('apply with warnings → a warning outcome, never a plain success', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [applyPath(5)]: () => jsonResponse(200, APPLY_WITH_WARNINGS),
      });
      const { user } = await renderDialog(LOCKED_CAKE);

      await user.click(await openConfirm(user, LOCK_BUTTON));
      await screen.findByDisplayValue('Shakar');

      expect(toasts('success')).toHaveLength(0);
      const warnings = toasts('warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('2 ta ogohlantirish');
      // Every warning stays on screen, in a live region that was already mounted.
      const stage = screen.getByText(STAGE_WARNING);
      expect(screen.getByText(MERGE_WARNING)).toBeInTheDocument();
      expect(stage.closest('[role="status"]')).not.toBeNull();
    });

    it('apply error (422) → error toast, lines unchanged, still "Qulflangan"', async () => {
      const message = "ERP'da topilmagan komponentlar: Vanilin, Kakao. Retsept o'zgartirilmadi.";
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [applyPath(5)]: () => jsonResponse(422, { error: { code: 'VALIDATION_ERROR', message } }),
      });
      const { onSaved, user } = await renderDialog(LOCKED_CAKE);

      await user.click(await openConfirm(user, LOCK_BUTTON));

      await waitFor(() => expect(toasts('error')).toContain(message));
      expect(toasts('success')).toHaveLength(0);
      expect(screen.getByText('Qulflangan')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Un (oliy nav)')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('Shakar')).toBeNull();
      expect(onSaved).not.toHaveBeenCalled();
      // The action is offered again so the user can retry after fixing ERP.
      await waitFor(() => expect(screen.getByRole('button', { name: LOCK_BUTTON })).toBeEnabled());
      expect(screen.getByRole('button', { name: LOCK_BUTTON })).toHaveFocus();
    });

    it('"Yo\'q" dismisses the confirm step without a request and returns focus', async () => {
      mockApi({ [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE) });
      const { user } = await renderDialog(LOCKED_CAKE);

      await user.click(screen.getByRole('button', { name: LOCK_BUTTON }));
      await user.click(screen.getByRole('button', { name: "Yo'q" }));

      expect(screen.queryByRole('button', { name: 'Ha, yangilash' })).toBeNull();
      expect(screen.getByRole('button', { name: LOCK_BUTTON })).toHaveFocus();
      expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);
    });

    it('Escape cancels the open confirm step instead of closing the dialog', async () => {
      mockApi({ [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE) });
      const { user, onOpenChange } = await renderDialog(LOCKED_CAKE);

      await user.click(screen.getByRole('button', { name: LOCK_BUTTON }));
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('button', { name: 'Ha, yangilash' })).toBeNull();
      expect(onOpenChange).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: LOCK_BUTTON })).toHaveFocus();
      expect(calls.filter((c) => c.startsWith('POST'))).toEqual([]);

      // With no confirm step open, Escape closes the dialog as usual.
      await user.keyboard('{Escape}');
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('unlocked recipe: "Poster\'dan hozir yangilash" applies without waiting for the sync', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [applyPath(5)]: () => jsonResponse(200, APPLY_RESULT),
      });
      const { user } = await renderDialog(UNLOCKED_CAKE);
      expect(screen.getByText('Qulfsiz')).toBeInTheDocument();

      const confirm = await openConfirm(user, REFRESH_BUTTON);
      expect(
        screen.getByText("Joriy retsept Poster'dagi retsept bilan almashtiriladi. Davom etasizmi?"),
      ).toBeInTheDocument();
      await user.click(confirm);

      expect(await screen.findByDisplayValue('Shakar')).toBeInTheDocument();
      expect(calls).toContain(`POST ${applyPath(5)}`);
      // It was not locked, so the toast does not claim to have unlocked it.
      expect(toasts('success')).toEqual([
        '"Shokoladli tort" retsepti Poster\'dan yangilandi: 2 ta komponent.',
      ]);
      expect(screen.queryByText('Ogohlantirishlar')).toBeNull();
    });

    it('marks the recipe busy and announces progress while an apply is in flight', async () => {
      const apply = deferred();
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [applyPath(5)]: () => apply.promise,
      });
      const { user } = await renderDialog(LOCKED_CAKE);

      await user.click(await openConfirm(user, LOCK_BUTTON));

      expect(screen.getByRole('button', { name: 'Saqlash' })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Posterdan yuklash/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: LOCK_BUTTON })).toBeDisabled();
      expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
      expect(screen.getByText("Poster'dan yangilanmoqda…")).toBeInTheDocument();

      await act(async () => {
        apply.resolve(jsonResponse(200, APPLY_RESULT));
      });

      await waitFor(() => expect(screen.getByRole('button', { name: 'Saqlash' })).toBeEnabled());
      expect(screen.getByRole('button', { name: /Posterdan yuklash/ })).toBeEnabled();
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
      expect(screen.queryByText("Poster'dan yangilanmoqda…")).toBeNull();
    });
  });

  describe('stale responses', () => {
    it('an apply from before a close + reopen of the SAME product is dropped', async () => {
      const apply = deferred();
      let recipeCalls = 0;
      mockApi({
        [recipePath(5)]: () =>
          jsonResponse(200, ++recipeCalls === 1 ? STORED_RECIPE : DOUGH_ONLY_RECIPE),
        [applyPath(5)]: () => apply.promise,
      });
      const { user, rerenderWith, onSaved } = await renderDialog(LOCKED_CAKE);

      await user.click(await openConfirm(user, LOCK_BUTTON));

      rerenderWith({ product: null, open: false });
      rerenderWith({ product: LOCKED_CAKE, open: true });
      expect(await screen.findByDisplayValue('Medovik testo')).toBeInTheDocument();
      // The new session starts idle: the old request no longer blocks it.
      expect(screen.getByRole('button', { name: 'Saqlash' })).toBeEnabled();
      expect(screen.getByRole('button', { name: LOCK_BUTTON })).toBeEnabled();

      await act(async () => {
        apply.resolve(jsonResponse(200, APPLY_WITH_WARNINGS));
      });
      // The server did change, so the list still refetches; wait for that,
      // then give React a tick to render anything the response might have set.
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      await settle();

      // Dropped silently: freshly loaded lines and lock state stay, no toast.
      expect(screen.getByDisplayValue('Medovik testo')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('Shakar')).toBeNull();
      expect(screen.getByText('Qulflangan')).toBeInTheDocument();
      expect(screen.queryByText(STAGE_WARNING)).toBeNull();
      expect(toasts('success')).toHaveLength(0);
      expect(toasts('warning')).toHaveLength(0);
    });

    it('an apply for product A that finishes while product B is open is dropped', async () => {
      const apply = deferred();
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [applyPath(5)]: () => apply.promise,
        [recipePath(6)]: () => jsonResponse(200, { ...DOUGH_ONLY_RECIPE, product_id: 6 }),
      });
      const { user, rerenderWith, onSaved } = await renderDialog(LOCKED_CAKE);

      await user.click(await openConfirm(user, LOCK_BUTTON));

      rerenderWith({ product: NAPOLEON, open: true });
      expect(await screen.findByDisplayValue('Medovik testo')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Saqlash' })).toBeEnabled();

      await act(async () => {
        apply.resolve(jsonResponse(200, APPLY_RESULT));
      });
      await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
      await settle();

      expect(screen.getByText('Retsept — Napoleon')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('Shakar')).toBeNull();
      expect(screen.getByText('Qulflangan')).toBeInTheDocument();
      expect(toasts('success')).toHaveLength(0);
    });

    it('a preview from before a close + reopen of the same product does not fill the new form', async () => {
      const preview = deferred();
      let recipeCalls = 0;
      mockApi({
        [recipePath(5)]: () =>
          jsonResponse(200, ++recipeCalls === 1 ? STORED_RECIPE : DOUGH_ONLY_RECIPE),
        [previewPath(5)]: () => preview.promise,
      });
      const { user, rerenderWith } = await renderDialog(LOCKED_CAKE);

      await user.click(screen.getByRole('button', { name: /Posterdan yuklash/ }));
      rerenderWith({ product: null, open: false });
      rerenderWith({ product: LOCKED_CAKE, open: true });
      expect(await screen.findByDisplayValue('Medovik testo')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Posterdan yuklash/ })).toBeEnabled();

      await act(async () => {
        preview.resolve(jsonResponse(200, { lines: [PREVIEW_SUGAR_LINE], not_found: [] }));
      });
      await waitFor(() => expect(calls).toContain(`GET ${previewPath(5)}`));
      await settle();

      expect(screen.getByDisplayValue('Medovik testo')).toBeInTheDocument();
      expect(screen.queryByDisplayValue('Shakar')).toBeNull();
      expect(toasts('success')).toHaveLength(0);
      expect(screen.queryByText('Ogohlantirishlar')).toBeNull();
    });
  });

  describe('lock state', () => {
    it('takes recipe_locked from the GET response over a stale list snapshot', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, { ...STORED_RECIPE, recipe_locked: false }),
      });
      await renderDialog(LOCKED_CAKE);

      expect(screen.getByText('Qulfsiz')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: REFRESH_BUTTON })).toBeInTheDocument();
    });

    it('shows "Qulflangan" when the GET says locked though the snapshot says not', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, { ...STORED_RECIPE, recipe_locked: true }),
      });
      await renderDialog(UNLOCKED_CAKE);

      expect(screen.getByText('Qulflangan')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: LOCK_BUTTON })).toBeInTheDocument();
    });
  });

  describe('"Posterdan yuklash" preview', () => {
    it('no lines → error toast, form untouched', async () => {
      const message = 'Posterda bu mahsulot uchun retsept yo‘q.';
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [previewPath(5)]: () => jsonResponse(200, { lines: [], not_found: [], message }),
      });
      const { user } = await renderDialog(LOCKED_CAKE);

      await user.click(screen.getByRole('button', { name: /Posterdan yuklash/ }));

      await waitFor(() => expect(toasts('error')).toContain(message));
      expect(toasts('success')).toHaveLength(0);
      expect(screen.getByDisplayValue('Un (oliy nav)')).toBeInTheDocument();
    });

    it('no lines and no message → the Uzbek fallback error', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [previewPath(5)]: () => jsonResponse(200, { lines: [], not_found: [] }),
      });
      const { user } = await renderDialog(LOCKED_CAKE);

      await user.click(screen.getByRole('button', { name: /Posterdan yuklash/ }));

      await waitFor(() =>
        expect(toasts('error')).toContain('Posterda bu mahsulot uchun retsept topilmadi.'),
      );
      expect(toasts('success')).toHaveLength(0);
    });

    it('not_found → loads the found lines, warns with the missing names and the lock caveat', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [previewPath(5)]: () =>
          jsonResponse(200, { lines: [PREVIEW_SUGAR_LINE], not_found: ['Vanilin', 'Kakao'] }),
      });
      const { user } = await renderDialog(LOCKED_CAKE);

      await user.click(screen.getByRole('button', { name: /Posterdan yuklash/ }));

      expect(await screen.findByDisplayValue('Shakar')).toBeInTheDocument();
      const warnings = toasts('warning');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('Topilmagan komponentlar: Vanilin, Kakao');
      // It must not invite a save: that would lock an incomplete recipe.
      expect(warnings[0]).toContain('qulf');
      expect(toasts('success')).toHaveLength(0);
      // …and the list stays visible in the dialog after the toast is gone.
      expect(screen.getByText('Ogohlantirishlar')).toBeInTheDocument();
      expect(screen.getByText(/Topilmagan komponentlar: Vanilin, Kakao/, { selector: 'li' }))
        .toBeInTheDocument();
      // A preview only fills the form — the recipe stays locked until "Saqlash".
      expect(screen.getByText('Qulflangan')).toBeInTheDocument();
      expect(calls).not.toContain(`POST ${applyPath(5)}`);
    });

    it('success names the Poster product and points to the apply button', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [previewPath(5)]: () =>
          jsonResponse(200, {
            lines: [PREVIEW_SUGAR_LINE],
            not_found: [],
            source: 'prepack',
            poster_name: 'Г/П МЕДОВИК ШОК ЧЕРНЫЙ',
          }),
      });
      const { user } = await renderDialog(LOCKED_CAKE);

      await user.click(screen.getByRole('button', { name: /Posterdan yuklash/ }));

      await waitFor(() => expect(toasts('success')).toHaveLength(1));
      const [message] = toasts('success');
      expect(message).toContain('Г/П МЕДОВИК ШОК ЧЕРНЫЙ');
      expect(message).toContain('1 ta komponent');
      expect(message).toContain('qulflaydi');
      expect(message).toContain(LOCK_BUTTON);
      expect(toasts('error')).toHaveLength(0);
      // The caveat stays in the dialog too.
      expect(screen.getByText(/"Saqlash" retseptni qulflaydi/, { selector: 'li' }))
        .toBeInTheDocument();
    });

    it('keeps enough precision for tiny quantities (no "0" that fails on save)', async () => {
      mockApi({
        [recipePath(5)]: () => jsonResponse(200, STORED_RECIPE),
        [previewPath(5)]: () =>
          jsonResponse(200, {
            lines: [
              { ...PREVIEW_SUGAR_LINE, qty_per_unit: 0.00003, brutto: 0.000035 },
              {
                ...PREVIEW_SUGAR_LINE, component_product_id: 3, component_name: 'Medovik testo',
                qty_per_unit: 0.123456789, brutto: 12.3456789,
              },
            ],
            not_found: [],
          }),
      });
      const { user } = await renderDialog(LOCKED_CAKE);

      await user.click(screen.getByRole('button', { name: /Posterdan yuklash/ }));

      expect(await screen.findByDisplayValue('0.00003')).toBeInTheDocument();
      expect(screen.getByDisplayValue('0.000035')).toBeInTheDocument();
      expect(screen.getByDisplayValue('0.123457')).toBeInTheDocument();
      expect(screen.getByDisplayValue('12.3457')).toBeInTheDocument();
    });
  });
});
