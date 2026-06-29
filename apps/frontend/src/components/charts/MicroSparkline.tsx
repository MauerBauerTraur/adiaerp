import { useId, useMemo } from 'react';
import type { ChainTone } from '@/lib/chainTokens';
import { cn } from '@/lib/utils';

/**
 * Sprint C — 14-point sparkline coloured by chain tone.
 *
 * Renders an inline SVG with a polyline + a soft gradient fill underneath.
 * Stroke colour resolves to the `--chain-<tone>` CSS variable so dark/light
 * theme inheritance works without prop plumbing. Inspired by Stripe and
 * Mercury sparklines — small, dense, no axis chrome.
 */
export interface MicroSparklineProps {
  values: number[];
  tone: ChainTone;
  height?: number;
  width?: number;
  className?: string;
  /** Accessible label override; defaults to "Chizma". */
  ariaLabel?: string;
}

const TONE_VAR: Record<ChainTone, string> = {
  raw: '--chain-raw',
  production: '--chain-production',
  supply: '--chain-supply',
  sex_storage: '--chain-supply',
  central: '--chain-central',
  store: '--chain-store',
};

export function MicroSparkline({
  values,
  tone,
  height = 36,
  width = 120,
  className,
  ariaLabel = 'Chizma',
}: MicroSparklineProps) {
  const gradientId = useId();
  const safe = values.length === 0 ? [0, 0] : values;

  const { polylinePoints, areaPath, lastPoint } = useMemo(() => {
    const min = Math.min(...safe);
    const max = Math.max(...safe);
    const span = max - min || 1;
    const stepX = safe.length > 1 ? width / (safe.length - 1) : width;

    const points: { x: number; y: number }[] = safe.map((v, i) => ({
      x: i * stepX,
      y: height - ((v - min) / span) * height,
    }));

    const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
    const area =
      `M0,${height} ` +
      points.map((p) => `L${p.x},${p.y}`).join(' ') +
      ` L${width},${height} Z`;
    const last = points[points.length - 1] ?? { x: width, y: height };
    return { polylinePoints: polyline, areaPath: area, lastPoint: last };
  }, [safe, height, width]);

  const stroke = `hsl(var(${TONE_VAR[tone]}))`;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width={width}
      height={height}
      className={cn('block', className)}
      data-tone={tone}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
          <stop offset="100%" stopColor={stroke} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} />
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={stroke}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Glow pulse halo on the last point — pulses to attract the eye to "now".
          Reduced-motion users see a static halved-opacity halo (handled in CSS). */}
      <circle
        cx={lastPoint.x}
        cy={lastPoint.y}
        r={3}
        fill={stroke}
        className="hero-kpi-sparkline-pulse"
        data-testid="micro-sparkline-pulse"
      />
      <circle cx={lastPoint.x} cy={lastPoint.y} r={1.8} fill={stroke} />
    </svg>
  );
}
