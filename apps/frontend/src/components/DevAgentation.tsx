import { Agentation } from 'agentation';

/**
 * Agentation visual-annotation overlay — DEV ONLY.
 *
 * The owner uses this in the browser to annotate UI; the agent receives
 * structured context (selectors, file paths). Rendered only when
 * `import.meta.env.DEV` is true, so it never ships in a production build.
 * Skipped under `MODE === 'test'` (vitest) — the overlay injects scoped
 * CSS that confuses jsdom's selector engine.
 * See: https://www.agentation.com/install
 */
export function DevAgentation() {
  if (!import.meta.env.DEV || import.meta.env.MODE === 'test') return null;
  return <Agentation endpoint="http://localhost:4747" />;
}
