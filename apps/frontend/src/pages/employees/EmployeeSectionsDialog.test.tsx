/**
 * EmployeeSectionsDialog — per-user bo'lim access (migration 0061).
 *
 * What we pin:
 *   1. An empty stored whitelist renders as "everything ticked" — no rows
 *      means the role default, which is what the user experiences today.
 *   2. Unticking screens PUTs exactly the remaining paths.
 *   3. Leaving everything ticked PUTs `[]` — the "no override" shape, so
 *      screens added later are not silently locked out.
 *   4. Saving with nothing ticked is blocked (it would round-trip as "no
 *      override" and grant everything).
 *   5. Only screens the user's ROLE can reach are offered.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EmployeeSectionsDialog } from './EmployeeSectionsDialog';
import { renderWithProviders, jsonResponse } from '@/test/render-helpers';
import { HIDDEN_GROUPS, navSectionsForRole } from '@/lib/navigation';
import type { User } from '@/lib/types';

const KEEPER: User = {
  id: 7,
  name: 'Anvar K',
  username: 'anvar.k',
  role: 'store_manager',
  location_id: 10,
};

/** Screens a store_manager can reach — the set the dialog should offer. */
const VISIBLE_PATHS = navSectionsForRole(KEEPER.role)
  .filter((s) => !HIDDEN_GROUPS.includes(s.key))
  .flatMap((s) => s.items.map((i) => i.path));

/** Mock `fetch`: the GET returns `stored`, the PUT echoes its body back. */
function mockApi(stored: string[]) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, init) => {
      if ((init as RequestInit | undefined)?.method === 'PUT') {
        return jsonResponse(200, { paths: [] });
      }
      return jsonResponse(200, { paths: stored });
    });
}

/**
 * Query checkboxes by id rather than label: "Boshqaruv paneli" is both a
 * group heading and the single screen inside it, so the label is ambiguous.
 */
function pageBox(path: string): HTMLInputElement {
  const el = document.getElementById(`page-${path}`);
  if (el === null) throw new Error(`no checkbox for page ${path}`);
  return el as HTMLInputElement;
}

function groupBox(key: string): HTMLInputElement {
  const el = document.getElementById(`section-${key}`);
  if (el === null) throw new Error(`no checkbox for group ${key}`);
  return el as HTMLInputElement;
}

/** Resolves once the dialog has loaded its stored whitelist. */
function whenLoaded(): Promise<HTMLElement> {
  return screen.findByLabelText("Do'konlar");
}

/** The body of the first PUT the component fired. */
function putBody(spy: ReturnType<typeof mockApi>): { paths: string[] } {
  const call = spy.mock.calls.find(
    (c) => (c[1] as RequestInit | undefined)?.method === 'PUT',
  );
  if (call === undefined) throw new Error('no PUT was fired');
  return JSON.parse((call[1] as RequestInit).body as string);
}

describe('EmployeeSectionsDialog', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ticks everything when no override is stored', async () => {
    mockApi([]);
    renderWithProviders(
      <EmployeeSectionsDialog user={KEEPER} onOpenChange={() => {}} />,
    );

    await whenLoaded();
    for (const path of VISIBLE_PATHS) {
      expect(pageBox(path).checked).toBe(true);
    }
  });

  it('offers only the screens the role can reach', async () => {
    mockApi([]);
    renderWithProviders(
      <EmployeeSectionsDialog user={KEEPER} onOpenChange={() => {}} />,
    );

    await whenLoaded();
    // Xom-ashyo ombori is raw_warehouse_manager territory — a store manager
    // must not even be offered it.
    expect(screen.queryByLabelText('Xom-ashyo ombori')).toBeNull();
    expect(document.getElementById('page-/raw-warehouse')).toBeNull();
  });

  it('ticks exactly the stored subset when an override exists', async () => {
    mockApi(['/dashboard', '/sotuvlar']);
    renderWithProviders(
      <EmployeeSectionsDialog user={KEEPER} onOpenChange={() => {}} />,
    );

    await whenLoaded();
    expect(pageBox('/dashboard').checked).toBe(true);
    expect(pageBox('/sotuvlar').checked).toBe(true);
    expect(pageBox('/stores').checked).toBe(false);
  });

  it('PUTs the remaining paths after unticking a screen', async () => {
    const spy = mockApi([]);
    renderWithProviders(
      <EmployeeSectionsDialog user={KEEPER} onOpenChange={() => {}} />,
    );
    const user = userEvent.setup();

    await whenLoaded();
    await user.click(pageBox('/stores'));
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      expect(putBody(spy).paths).toEqual(
        VISIBLE_PATHS.filter((p) => p !== '/stores'),
      );
    });
  });

  it('PUTs an empty array when everything stays ticked', async () => {
    const spy = mockApi([]);
    renderWithProviders(
      <EmployeeSectionsDialog user={KEEPER} onOpenChange={() => {}} />,
    );
    const user = userEvent.setup();

    await whenLoaded();
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      // "No override" — so a screen added to the app next month still shows
      // up for this user instead of vanishing.
      expect(putBody(spy).paths).toEqual([]);
    });
  });

  it('blocks saving with nothing ticked', async () => {
    mockApi(['/dashboard']);
    renderWithProviders(
      <EmployeeSectionsDialog user={KEEPER} onOpenChange={() => {}} />,
    );
    const user = userEvent.setup();

    await whenLoaded();
    await user.click(pageBox('/dashboard'));

    expect(
      screen.getByRole('button', { name: 'Saqlash' }),
    ).toBeDisabled();
    expect(screen.getByRole('alert').textContent).toMatch(/kamida bitta/i);
  });

  it('toggles a whole group from its heading checkbox', async () => {
    const spy = mockApi([]);
    renderWithProviders(
      <EmployeeSectionsDialog user={KEEPER} onOpenChange={() => {}} />,
    );
    const user = userEvent.setup();

    // The "Modullar" group heading clears every screen inside it.
    await whenLoaded();
    await user.click(groupBox('modules'));
    await user.click(screen.getByRole('button', { name: 'Saqlash' }));

    await waitFor(() => {
      const saved = putBody(spy).paths;
      expect(saved).toContain('/dashboard');
      expect(saved).not.toContain('/stores');
      expect(saved).not.toContain('/sotuvlar');
    });
  });
});
