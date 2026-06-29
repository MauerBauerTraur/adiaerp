/**
 * Manual smoke test for the Poster client — exercises a few read-only
 * endpoints against the real Poster account and prints a short summary.
 *
 * Run with: `npm run poster:test -w @adia/backend`
 *
 * Idempotent and read-only — never writes to the local DB.
 */
import { createPosterClientFromConfig } from '../src/integrations/poster/client.js';

async function main(): Promise<void> {
  const client = createPosterClientFromConfig();

  const spots = await client.getSpots();
  console.log(`access.getSpots         -> ${spots.length} spots`);
  for (const s of spots) {
    console.log(`  spot_id=${s.spot_id} name=${(s.spot_name ?? s.name).trim()}`);
  }

  const storages = await client.getStorages();
  console.log(`storage.getStorages     -> ${storages.length} storages`);

  const ingredients = await client.getIngredients();
  console.log(`menu.getIngredients     -> ${ingredients.length} ingredients`);

  const products = await client.getProducts();
  console.log(`menu.getProducts        -> ${products.length} products`);

  const prepacks = await client.getPrepacks();
  console.log(
    `menu.getPrepacks        -> ${prepacks.length} prepacks (with ingredients=${
      prepacks.filter((p) => Array.isArray(p.ingredients) && p.ingredients.length > 0).length
    })`,
  );

  // Pick the first type=2 product and fetch its BOM.
  const type2 = products.find((p) => p.type === '2');
  if (type2 !== undefined) {
    const full = await client.getProduct(Number(type2.product_id));
    const ings = full?.ingredients ?? [];
    console.log(
      `menu.getProduct id=${type2.product_id} -> ${ings.length} ingredients (BOM)`,
    );
  }

  if (storages.length > 0) {
    const leftovers = await client.getStorageLeftovers(Number(storages[0]!.storage_id));
    const neg = leftovers.filter((l) => Number(l.storage_ingredient_left) < 0).length;
    console.log(
      `storage.getStorageLeftovers storage_id=${storages[0]!.storage_id} -> ` +
        `${leftovers.length} rows (negative=${neg})`,
    );
  }
}

main().catch((err) => {
  console.error('[poster:test] failed:', err);
  process.exit(1);
});
