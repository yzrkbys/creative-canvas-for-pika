// ---------------------------------------------------------------------------
// Drift check between the committed catalog snapshot and the live Pika catalog.
//
// The snapshot is what makes the server start offline and deterministically,
// but it goes stale silently: an endpoint renamed upstream stays selectable in
// the UI and only fails at run time — after the user has confirmed a paid run.
// That is the worst moment to find out, so this probes /catalog/apis once at
// boot (public, no API key) and reports the difference.
//
// It never blocks startup and never mutates the snapshot: the fix is to re-run
// `npm run sync:catalog`, which is a decision for a human.
// ---------------------------------------------------------------------------
import { CATALOG } from "./registry.js";

const BASE = process.env.PIKA_API_BASE ?? "https://api.dev.pika.art";
const TIMEOUT_MS = 8000;

export interface CatalogDrift {
  checked: boolean;
  syncedAt?: string;
  /** Endpoints we still offer that the live catalog no longer lists. These are
   *  the ones that 404 mid-run, so they matter more than the additions. */
  stale: string[];
  /** Endpoints the live catalog has that this snapshot predates. */
  missing: string[];
  error?: string;
}

let drift: CatalogDrift = { checked: false, stale: [], missing: [] };

export function catalogDrift(): CatalogDrift {
  return drift;
}

export async function checkCatalogDrift(): Promise<CatalogDrift> {
  const local = CATALOG;
  try {
    const res = await fetch(`${BASE}/catalog/apis`, {
      headers: { "user-agent": "PikaCanvas/catalog-check" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { apis?: { api_id?: string }[] };
    // Compare on api_id. The live list carries "vendor/model/function" while the
    // snapshot also stores the full "/v1/media/..." path — comparing those two
    // forms marks every endpoint both stale and new.
    const live = new Set((body.apis ?? []).map((a) => a.api_id ?? "").filter(Boolean));
    if (!live.size) throw new Error("live catalog returned no endpoints");

    const localIds = local.entries.map((e) => e.apiId);
    drift = {
      checked: true,
      syncedAt: local.syncedAt,
      stale: localIds.filter((id) => !live.has(id)).sort(),
      missing: [...live].filter((id) => !localIds.includes(id)).sort(),
    };

    if (drift.stale.length || drift.missing.length) {
      console.warn(
        `[catalog] snapshot from ${local.syncedAt} has drifted: ` +
          `${drift.stale.length} endpoint(s) no longer offered upstream, ` +
          `${drift.missing.length} new upstream. Run \`npm run sync:catalog\`.`,
      );
      for (const p of drift.stale.slice(0, 10)) console.warn(`[catalog]   stale: ${p}`);
      if (drift.stale.length > 10) console.warn(`[catalog]   ...and ${drift.stale.length - 10} more`);
    } else {
      console.log(`[catalog] snapshot matches the live catalog (${localIds.length} endpoints)`);
    }
  } catch (err) {
    // Offline is a normal way to run this app; a failed probe is not an error.
    drift = {
      checked: false,
      syncedAt: local.syncedAt,
      stale: [],
      missing: [],
      error: (err as Error).message,
    };
  }
  return drift;
}
