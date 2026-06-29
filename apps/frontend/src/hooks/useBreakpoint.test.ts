import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useBreakpoint, useIsMobile } from './useBreakpoint';

function setViewport(width: number) {
  act(() => {
    (window as unknown as { innerWidth: number }).innerWidth = width;
    window.dispatchEvent(new Event('resize'));
  });
}

describe('useBreakpoint', () => {
  const originalWidth = window.innerWidth;
  afterEach(() => {
    (window as unknown as { innerWidth: number }).innerWidth = originalWidth;
  });

  it('returns `xs` for sub-640 widths', () => {
    (window as unknown as { innerWidth: number }).innerWidth = 390;
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('xs');
  });

  it('returns `sm` for 640..1023', () => {
    (window as unknown as { innerWidth: number }).innerWidth = 768;
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('sm');
  });

  it('returns `lg` for 1024..1279', () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1200;
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('lg');
  });

  it('returns `xl` for 1280+', () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1440;
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('xl');
  });

  it('updates on window resize', () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1440;
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current).toBe('xl');
    setViewport(390);
    expect(result.current).toBe('xs');
    setViewport(900);
    expect(result.current).toBe('sm');
  });
});

describe('useIsMobile', () => {
  const originalWidth = window.innerWidth;
  afterEach(() => {
    (window as unknown as { innerWidth: number }).innerWidth = originalWidth;
  });

  it('is true for sub-1024 widths', () => {
    (window as unknown as { innerWidth: number }).innerWidth = 800;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it('is false for desktop widths', () => {
    (window as unknown as { innerWidth: number }).innerWidth = 1440;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });
});
