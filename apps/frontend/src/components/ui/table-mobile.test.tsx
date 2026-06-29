import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MobileCardList } from './table-mobile';

describe('MobileCardList', () => {
  it('renders one card per item with title and fields', () => {
    render(
      <MobileCardList
        items={[
          {
            id: 1,
            title: 'Un',
            fields: [
              { label: 'Qoldiq', value: '12 kg' },
              { label: 'Min', value: '5 kg' },
            ],
          },
          {
            id: 2,
            title: 'Shakar',
            fields: [{ label: 'Qoldiq', value: '3 kg' }],
          },
        ]}
      />,
    );
    expect(screen.getByText('Un')).toBeInTheDocument();
    expect(screen.getByText('Shakar')).toBeInTheDocument();
    expect(screen.getByText('12 kg')).toBeInTheDocument();
    expect(screen.getByText('Min')).toBeInTheDocument();
  });

  it('shows the empty message when items is empty', () => {
    render(<MobileCardList items={[]} emptyMessage="Bo'sh." />);
    expect(screen.getByText("Bo'sh.")).toBeInTheDocument();
  });

  it('fires onClick and supports Enter / Space activation', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <MobileCardList
        items={[{ id: 1, title: 'Un', onClick }]}
      />,
    );
    const card = screen.getByRole('button');
    await user.click(card);
    expect(onClick).toHaveBeenCalledTimes(1);
    card.focus();
    await user.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledTimes(2);
    await user.keyboard(' ');
    expect(onClick).toHaveBeenCalledTimes(3);
  });
});
