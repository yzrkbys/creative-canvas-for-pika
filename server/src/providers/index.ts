import { pikaAdapter } from "./pika.js";
import { mockAdapter } from "./mock.js";
import type { ProviderAdapter } from "../types.js";

const ADAPTERS: ProviderAdapter[] = [pikaAdapter];

export function isMockMode(): boolean {
  return process.env.MOCK_PROVIDER === "1" || process.env.MOCK_PROVIDER === "true";
}

// In mock mode every model routes through the mock adapter (same model ids,
// zero cost) so the full pipeline can be exercised without a key.
export function adapterFor(model: string): ProviderAdapter {
  if (isMockMode()) return mockAdapter;
  const a = ADAPTERS.find((x) => x.supports(model));
  if (!a) throw new Error(`no provider adapter supports model "${model}"`);
  return a;
}
