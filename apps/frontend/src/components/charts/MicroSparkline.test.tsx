import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MicroSparkline } from './MicroSparkline';

describe('MicroSparkline', () => {
  it('renders a polyline + gradient area for the supplied values', () => {
    const { container } = render(
      <MicroSparkline values={[1, 3, 2, 5, 4]} tone="central" />,
    );
    expect(container.querySelector('polyline')).not.toBeNull();
    expect(container.querySelector('linearGradient')).not.toBeNull();
    expect(container.querySelector('svg')?.getAttribute('data-tone')).toBe(
      'central',
    );
  });

  it('renders a glow-pulse halo at the last point', () => {
    const { getByTestId } = render(
      <MicroSparkline values={[2, 4, 6, 8]} tone="raw" />,
    );
    const halo = getByTestId('micro-sparkline-pulse');
    expect(halo.getAttribute('class')).toContain('hero-kpi-sparkline-pulse');
  });

  it('falls back gracefully when given an empty series', () => {
    const { container } = render(<MicroSparkline values={[]} tone="store" />);
    // SVG still mounts — no crash, no missing nodes.
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('polyline')).not.toBeNull();
  });
});
