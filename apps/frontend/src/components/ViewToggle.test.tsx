import { describe, it, expect, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewToggle, useViewMode, type ViewMode } from './ViewToggle';

function Harness({ pageKey = 'test' }: { pageKey?: string }) {
  const [mode, setMode] = useViewMode(pageKey, 'card');
  return (
    <>
      <ViewToggle value={mode} onChange={setMode} />
      <span data-testid="current-mode">{mode}</span>
    </>
  );
}

function ControlledHarness() {
  const [mode, setMode] = useState<ViewMode>('card');
  return (
    <>
      <ViewToggle value={mode} onChange={setMode} />
      <span data-testid="current-mode">{mode}</span>
    </>
  );
}

describe('ViewToggle', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders two tabs with the card tab active by default', () => {
    render(<ControlledHarness />);
    const card = screen.getByRole('tab', { name: 'Card' });
    const table = screen.getByRole('tab', { name: 'Table' });
    expect(card).toHaveAttribute('aria-selected', 'true');
    expect(table).toHaveAttribute('aria-selected', 'false');
  });

  it('switches to the table view when the table tab is clicked', () => {
    render(<ControlledHarness />);
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    expect(screen.getByTestId('current-mode')).toHaveTextContent('table');
    expect(screen.getByRole('tab', { name: 'Table' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });
});

describe('useViewMode', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('persists the selection under adia.view.<pageKey>', () => {
    render(<Harness pageKey="products" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Table' }));
    expect(window.localStorage.getItem('adia.view.products')).toBe('table');
  });

  it('hydrates from localStorage on mount', () => {
    window.localStorage.setItem('adia.view.employees', 'table');
    render(<Harness pageKey="employees" />);
    expect(screen.getByTestId('current-mode')).toHaveTextContent('table');
    expect(screen.getByRole('tab', { name: 'Table' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('keeps per-page keys isolated', () => {
    window.localStorage.setItem('adia.view.products', 'table');
    window.localStorage.setItem('adia.view.users', 'card');
    const { unmount } = render(<Harness pageKey="products" />);
    expect(screen.getByTestId('current-mode')).toHaveTextContent('table');
    unmount();
    render(<Harness pageKey="users" />);
    expect(screen.getByTestId('current-mode')).toHaveTextContent('card');
  });
});
