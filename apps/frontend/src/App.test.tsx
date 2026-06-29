import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from './App';

describe('App', () => {
  it('renders the login page for an unauthenticated visitor', () => {
    render(<App />);
    // Unauthenticated users are redirected to /login by ProtectedRoute.
    expect(
      screen.getByRole('button', { name: 'Kirish' }),
    ).toBeInTheDocument();
  });

  it('shows the ADIA ERP brand on the login screen', () => {
    render(<App />);
    expect(screen.getByText('ADIA ERP')).toBeInTheDocument();
  });
});
