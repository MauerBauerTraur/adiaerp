import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

interface HeaderSlotState {
  content: ReactNode;
  setContent: (next: ReactNode) => void;
}

const HeaderSlotContext = createContext<HeaderSlotState | null>(null);

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null);
  return (
    <HeaderSlotContext.Provider value={{ content, setContent }}>
      {children}
    </HeaderSlotContext.Provider>
  );
}

/** Read the current slot content — used by the AppLayout header to render. */
export function useHeaderSlotContent(): ReactNode {
  const ctx = useContext(HeaderSlotContext);
  return ctx?.content ?? null;
}

/**
 * Mount-style hook: a page passes its header content, which appears in
 * the global app header until the page unmounts (then it's cleared).
 */
export function useHeaderSlot(content: ReactNode): void {
  const ctx = useContext(HeaderSlotContext);
  const set = ctx?.setContent;
  const setStable = useCallback(
    (next: ReactNode) => {
      set?.(next);
    },
    [set],
  );
  useEffect(() => {
    setStable(content);
    return () => setStable(null);
  }, [content, setStable]);
}
