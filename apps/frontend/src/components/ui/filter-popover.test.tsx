import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  FilterPopover,
  type FilterGroup,
  type FilterValue,
} from './filter-popover';

const GROUPS: FilterGroup[] = [
  {
    key: 'type',
    label: 'Mahsulot turi',
    searchable: false,
    options: [
      { value: 'raw', label: 'Xom-ashyo' },
      { value: 'semi', label: 'Yarim tayyor' },
      { value: 'finished', label: 'Tayyor mahsulot' },
    ],
  },
  {
    key: 'unit',
    label: 'O‘lchov birligi',
    searchable: false,
    options: [
      { value: 'kg', label: 'kg' },
      { value: 'l', label: 'l' },
      { value: 'pcs', label: 'dona' },
    ],
  },
];

function Harness({
  onApply,
  initial = { type: [], unit: [] },
}: {
  onApply?: (v: FilterValue) => void;
  initial?: FilterValue;
}) {
  const [value, setValue] = useState<FilterValue>(initial);
  return (
    <FilterPopover
      groups={GROUPS}
      value={value}
      onApply={(next) => {
        setValue(next);
        onApply?.(next);
      }}
    />
  );
}

describe('FilterPopover (EPIC 1.1)', () => {
  it('opens on the trigger and shows the first group options', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));

    expect(
      screen.getByRole('checkbox', { name: 'Tayyor mahsulot' }),
    ).toBeTruthy();
  });

  it('only applies selections on "Qo‘llash"', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<Harness onApply={onApply} />);

    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));
    await user.click(
      screen.getByRole('checkbox', { name: 'Tayyor mahsulot' }),
    );

    // Draft only — nothing lifted yet.
    expect(onApply).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Qo‘llash' }));
    expect(onApply).toHaveBeenCalledWith({ type: ['finished'], unit: [] });
  });

  it('shows the applied count on the trigger', async () => {
    render(<Harness initial={{ type: ['finished', 'semi'], unit: ['kg'] }} />);
    // 3 applied selections total.
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('clears the draft with "Hammasini tozalash"', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<Harness onApply={onApply} initial={{ type: ['finished'], unit: [] }} />);

    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));
    await user.click(
      screen.getByRole('button', { name: 'Hammasini tozalash' }),
    );
    await user.click(screen.getByRole('button', { name: 'Qo‘llash' }));

    expect(onApply).toHaveBeenCalledWith({ type: [], unit: [] });
  });

  it('switches groups via the tabs', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: 'Filtrlarni ochish' }));
    await user.click(screen.getByRole('tab', { name: 'O‘lchov birligi' }));

    expect(screen.getByRole('checkbox', { name: 'kg' })).toBeTruthy();
  });
});
