import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DateRangeFilter,
  dateRangeToQuery,
  type DateRangeValue,
} from './DateRangeFilter';

function Harness({ onChange }: { onChange?: (v: DateRangeValue) => void }) {
  const [value, setValue] = useState<DateRangeValue>({ range: 'today' });
  return (
    <DateRangeFilter
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('DateRangeFilter', () => {
  it('exposes the four preset tabs and highlights the active one', () => {
    render(<Harness />);

    const bugun = screen.getByRole('tab', { name: 'Bugun' });
    const buHafta = screen.getByRole('tab', { name: 'Bu hafta' });
    const buOy = screen.getByRole('tab', { name: 'Bu oy' });
    const olti = screen.getByRole('tab', { name: '6 oy' });

    expect(bugun).toHaveAttribute('aria-selected', 'true');
    expect(buHafta).toHaveAttribute('aria-selected', 'false');
    expect(buOy).toHaveAttribute('aria-selected', 'false');
    expect(olti).toHaveAttribute('aria-selected', 'false');
  });

  it('switches between presets when tabs are clicked', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole('tab', { name: 'Bu hafta' }));
    expect(onChange).toHaveBeenLastCalledWith({ range: 'week' });

    fireEvent.click(screen.getByRole('tab', { name: '6 oy' }));
    expect(onChange).toHaveBeenLastCalledWith({ range: '6m' });

    expect(screen.getByRole('tab', { name: '6 oy' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('opens the calendar popover with Uzbek weekday codes', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(
      screen.getByRole('button', { name: /Sana oralig.i — kalendar/ }),
    );

    // Weekday header row in Uzbek shorthand. DU SE CHO PA JU SHA YA.
    expect(await screen.findByText('DU')).toBeInTheDocument();
    expect(screen.getByText('CHO')).toBeInTheDocument();
    expect(screen.getByText('YA')).toBeInTheDocument();
  });

  it("disables Qo'llash until a full range is picked", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(
      screen.getByRole('button', { name: /Sana oralig.i — kalendar/ }),
    );

    const apply = await screen.findByRole('button', { name: "Qo'llash" });
    expect(apply).toBeDisabled();
  });
});

describe('dateRangeToQuery', () => {
  it('serialises preset ranges to a single param', () => {
    expect(dateRangeToQuery({ range: 'today' })).toBe('range=today');
    expect(dateRangeToQuery({ range: 'week' })).toBe('range=week');
    expect(dateRangeToQuery({ range: 'month' })).toBe('range=month');
    expect(dateRangeToQuery({ range: '6m' })).toBe('range=6m');
  });

  it('serialises custom ranges with from/to', () => {
    expect(
      dateRangeToQuery({
        range: 'custom',
        from: '2026-05-01',
        to: '2026-05-15',
      }),
    ).toBe('range=custom&from=2026-05-01&to=2026-05-15');
  });

  it('falls back to range=custom alone when from/to are missing', () => {
    expect(dateRangeToQuery({ range: 'custom' })).toBe('range=custom');
  });
});
