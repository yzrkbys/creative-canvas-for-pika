#!/usr/bin/env node
/**
 * Generate server/src/pika-catalog.json from Pika's public catalog.
 *
 * Pika exposes every endpoint's full JSON Schema at
 *   GET /catalog/apis                       -> the list
 *   GET /catalog/apis/{api_id}?expand=inputs -> input_schema + display_pricing
 * and both are public (no API key). That makes the whole model registry
 * derivable instead of hand-written: params, defaults, enums, min/max, which
 * fields take media, and the exact price tiers all come from here.
 *
 * The output is a snapshot committed next to the source so the server starts
 * offline and deterministically. Re-run this when Pika ships new models:
 *
 *   node server/scripts/sync-catalog.mjs            # write src/pika-catalog.json
 *   node server/scripts/sync-catalog.mjs --out FILE # write somewhere else
 *
 * It exits non-zero if the catalog introduces a media field this build does not
 * know how to wire (see pika-port-bindings.json) — better to fail the sync than
 * to ship a node that silently drops the user's inputs and bills them anyway.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "src");
const BASE = process.env.PIKA_API_BASE ?? "https://api.dev.pika.art";
// 2, not 8: the catalog API rate-limits bursts of detail fetches (HTTP 429
// observed at 8-wide on a 125+ endpoint catalog even with backoff).
const CONCURRENCY = 2;

const outFlag = process.argv.indexOf("--out");
const OUT = outFlag > -1 ? path.resolve(process.argv[outFlag + 1]) : path.join(SRC, "pika-catalog.json");

const BINDINGS = JSON.parse(readFileSync(path.join(SRC, "pika-port-bindings.json"), "utf8")).fields;

// Pika names the free-text field `prompt` on 79 endpoints and `text` on 5.
const TEXT_FIELDS = ["prompt", "text"];

// The catalog is public, but early-access models (e.g. Wan 3.0 during its
// closed beta) only appear when the request carries an allowlisted API key.
// Reads PIKA_API_KEY from the environment; without it the sync still works,
// it just cannot see gated models.
const API_KEY = process.env.PIKA_API_KEY;

async function getJson(p) {
  const headers = { "user-agent": "PikaCanvas/sync-catalog" };
  if (API_KEY) headers["X-API-Key"] = API_KEY;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + p, { headers }).catch((e) => {
      if (attempt >= 7) throw e;
      return null; // transient network error — retry
    });
    if (res && res.ok) return res.json();
    // 125+ endpoint detail fetches trip the API's rate limit; back off and retry.
    if (attempt >= 7 || (res && res.status !== 429 && res.status < 500)) {
      throw new Error(`GET ${p} -> HTTP ${res ? res.status : "network error"}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

/**
 * Collapse `anyOf: [X, null]` — Pika's shape for "optional X" — down to X, so
 * an optional enum still reads as an enum. Keeps the outer description/default.
 */
function unwrap(prop) {
  if (!prop || !Array.isArray(prop.anyOf)) return prop ?? {};
  const real = prop.anyOf.filter((c) => c.type !== "null");
  if (real.length !== 1) return prop; // genuine union — treat as freeform
  const merged = { ...real[0] };
  for (const k of ["description", "default", "title"]) {
    if (k in prop && !(k in merged)) merged[k] = prop[k];
  }
  return merged;
}

/**
 * Media fields are self-describing: the schema tags them with `media_kinds`.
 * Three shapes occur:
 *   1. a plain string field           -> image_url
 *   2. an array of tagged strings     -> image_urls: [url, url]
 *   3. an array of tagged OBJECTS     -> keyframes: [{image_url, at_s}, ...]
 * Shape 3 (FLUX 3's keyframes) hides `media_kinds` one level down, inside the
 * item object. Without this branch the field is not seen as media at all, so
 * the connected images are never sent — and a required field like `keyframes`
 * would bill for a run that carried no pictures.
 */
function mediaKindsOf(prop, defs = {}) {
  if (Array.isArray(prop.media_kinds)) return { kinds: prop.media_kinds, array: false };
  if (prop.type !== "array") return null;
  const item = unwrap(resolveRefs(prop.items ?? {}, defs));
  if (Array.isArray(item.media_kinds)) return { kinds: item.media_kinds, array: true };
  if (item.type === "object" && item.properties) {
    for (const [name, sub] of Object.entries(item.properties)) {
      const s = unwrap(sub);
      if (!Array.isArray(s.media_kinds)) continue;
      // Scalar siblings (FLUX 3's `at_s`) let each item be positioned. They are
      // surfaced as one comma-separated param rather than a bespoke widget.
      const extras = Object.entries(item.properties)
        .filter(([n, v]) => n !== name && !Array.isArray(unwrap(v).media_kinds))
        .map(([n, v]) => ({
          key: n,
          label: unwrap(v).title || n,
          description: unwrap(v).description,
          required: (item.required ?? []).includes(n),
        }));
      return { kinds: s.media_kinds, array: true, itemField: name, itemExtras: extras };
    }
  }
  return null;
}

/** A human label for a param key: "aspect_ratio" -> "Aspect ratio". */
function labelOf(key, prop) {
  if (typeof prop.title === "string" && prop.title.trim()) return prop.title.trim();
  return key.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

const ENUMERATE_LIMIT = 40;

/**
 * Some params are a union of a bounded number range and a literal — Seedance's
 * `duration` is `anyOf: [integer 4..15, const "auto"]`. Enumerating that into a
 * select keeps the flagship video models on the normal param UI instead of
 * pushing their most-used control into the raw-JSON escape hatch.
 * Returns null when a branch is open-ended (then it really is freeform).
 */
function enumerateUnion(branches) {
  const opts = [];
  for (const b of branches) {
    if (b.const !== undefined) {
      opts.push(String(b.const));
      continue;
    }
    const int = b.type === "integer" && typeof b.minimum === "number" && typeof b.maximum === "number";
    if (!int || b.maximum - b.minimum + 1 > ENUMERATE_LIMIT) return null;
    for (let v = b.minimum; v <= b.maximum; v++) opts.push(String(v));
  }
  return opts.length && opts.length <= ENUMERATE_LIMIT ? opts : null;
}

/**
 * Turn one schema property into a canvas ParamField. Returns null for shapes the
 * simple param UI cannot express (objects, arrays of structured items) — those
 * stay reachable through the node's raw-JSON escape hatch instead of being lost.
 */
function toParamField(key, prop) {
  const label = labelOf(key, prop);

  // Union left intact by unwrap() (two or more non-null branches).
  if (Array.isArray(prop.anyOf)) {
    const branches = prop.anyOf.filter((b) => b.type !== "null");
    const opts = enumerateUnion(branches);
    if (!opts) return null;
    return {
      key,
      label,
      type: "select",
      options: opts,
      // A union mixes numbers with literals ("4".."15" plus "auto"), so the
      // coercion has to be per-value: send 5 as a number, "auto" as a string.
      // Coercing the whole field either way would put garbage on the wire.
      valueType: "loose",
      description: prop.description,
    };
  }

  const enumVals = prop.enum ?? prop.const !== undefined ? (prop.enum ?? [prop.const]) : null;

  if (enumVals) {
    return {
      key,
      label,
      type: "select",
      options: enumVals.map(String),
      valueType: prop.type === "integer" || prop.type === "number" ? "number" : "string",
      description: prop.description,
    };
  }
  if (prop.type === "boolean") {
    // ParamField has no boolean type; the adapter coerces "on"/"off" back via valueType.
    return { key, label, type: "select", options: ["off", "on"], valueType: "boolean", description: prop.description };
  }
  if (prop.type === "integer" || prop.type === "number") {
    const f = { key, label, type: "number", valueType: prop.type === "integer" ? "integer" : "number", description: prop.description };
    if (typeof prop.minimum === "number") f.min = prop.minimum;
    if (typeof prop.maximum === "number") f.max = prop.maximum;
    f.step = prop.type === "integer" ? 1 : 0.1;
    return f;
  }
  if (prop.type === "string") {
    const f = { key, label, type: "string", valueType: "string", description: prop.description };
    if (typeof prop.maxLength === "number") f.maxLength = prop.maxLength;
    return f;
  }
  return null; // object / array / open union
}

function pricingOf(entry) {
  const comps = entry.display_pricing?.components ?? [];
  // The output component is what the canvas bills the user for; input-token
  // components (LLMs) are reported separately below.
  const out = comps.find((c) => c.role === "output");
  if (!out) return null;
  return {
    unit: out.unit?.type ?? "unknown",
    quantity: Number(out.unit?.quantity ?? 1),
    tiers: (out.price_tiers ?? []).map((t) => ({
      spec: t.spec ?? {},
      usd: Number(t.sell_usd),
    })),
    inputUsd: (() => {
      const inp = comps.find((c) => c.role === "input" && c.unit?.type === "input_token");
      return inp ? Number(inp.starting_at?.sell_usd) : undefined;
    })(),
  };
}

/**
 * Inline `$ref`s one level deep so a structured param carries its own shape.
 * The raw-JSON escape hatch is only usable if the user (or an agent) can see
 * what the object is supposed to look like.
 */
function resolveRefs(node, defs, depth = 0) {
  if (!node || typeof node !== "object" || depth > 3) return node;
  if (Array.isArray(node)) return node.map((n) => resolveRefs(n, defs, depth + 1));
  if (typeof node.$ref === "string") {
    const name = node.$ref.split("/").pop();
    const target = defs[name];
    return target ? resolveRefs({ ...target }, defs, depth + 1) : node;
  }
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = resolveRefs(v, defs, depth + 1);
  return out;
}

function normalize(entry) {
  const schema = entry.input_schema ?? {};
  const props = schema.properties ?? {};
  const defs = schema.$defs ?? {};
  const required = new Set(schema.required ?? []);

  const media = [];
  const params = [];
  const defaults = {};
  const advanced = [];
  let textField = null;
  let textMaxLength;

  for (const [key, raw] of Object.entries(props)) {
    const prop = unwrap(raw);
    const mk = mediaKindsOf(prop, defs);

    if (mk) {
      const f = { field: key, kinds: mk.kinds, array: mk.array, required: required.has(key) };
      if (mk.array && typeof prop.maxItems === "number") f.maxItems = prop.maxItems;
      if (mk.array && typeof prop.minItems === "number") f.minItems = prop.minItems;
      if (mk.itemField) {
        f.itemField = mk.itemField;
        if (mk.itemExtras?.length) f.itemExtras = mk.itemExtras;
        // One param per positioning sibling, taking a comma-separated list the
        // same length as the connected media (or blank to leave it to the model).
        for (const ex of mk.itemExtras ?? []) {
          const pkey = `${key}_${ex.key}`;
          params.push({
            key: pkey,
            label: `${labelOf(key, prop)} · ${ex.label}`,
            type: "string",
            valueType: "string",
            description:
              (ex.description ? ex.description + " " : "") +
              "接続したメディアと同数をカンマ区切りで指定します（空欄ならモデルに任せます）。",
          });
          defaults[pkey] = "";
        }
      }
      media.push(f);
      continue;
    }

    if (!textField && TEXT_FIELDS.includes(key) && prop.type === "string") {
      textField = key;
      if (typeof prop.maxLength === "number") textMaxLength = prop.maxLength;
      continue; // the node's prompt box drives this, not a param widget
    }

    const field = toParamField(key, prop);
    if (!field) {
      advanced.push({
        key,
        label: labelOf(key, prop),
        required: required.has(key),
        description: prop.description,
        schema: resolveRefs(prop, defs),
      });
      continue;
    }
    if (prop.default !== undefined && prop.default !== null) {
      defaults[key] = field.valueType === "boolean" ? (prop.default ? "on" : "off") : prop.default;
    } else if (required.has(key)) {
      // Required with no declared default. "Leave it unset" is not an option
      // here — omitting it is a guaranteed 422, so the field must carry a
      // concrete value (26 endpoints are in this state, including all nine
      // Seedance ones, whose `duration`/`resolution` are required).
      // Pick mechanically: the first enum option, or the schema's minimum.
      // Where nothing sensible exists (a required free-text voice_id), leave it
      // blank and let `required` make the adapter stop before it bills.
      field.required = true;
      defaults[key] =
        field.type === "select"
          ? field.options[0]
          : field.type === "number" && typeof field.min === "number"
            ? field.min
            : "";
    } else {
      // Optional and undeclared: leave it unset rather than inventing one.
      // Picking the first enum value would silently pin a model to settings the
      // API never chose. "" means "omit the field and let Pika decide", and the
      // adapter drops empty params before sending.
      defaults[key] = "";
      if (field.type === "select") field.options = ["", ...field.options];
    }
    params.push(field);
  }

  // Required params the simple UI cannot render must be visible, not silent:
  // the adapter refuses to run these until the raw-JSON param supplies them.
  const requiredAdvanced = advanced.filter((a) => a.required).map((a) => a.key);

  return {
    apiId: entry.api_id,
    vendor: entry.vendor,
    fn: entry.function ?? null,
    category: entry.category,
    name: entry.name,
    description: entry.description ?? "",
    method: entry.call?.method ?? "POST",
    path: entry.call?.path ?? `/v1/media/${entry.api_id}`,
    textField,
    textMaxLength,
    media,
    params,
    defaults,
    advanced,
    requiredAdvanced,
    requiredFields: [...required],
    pricing: pricingOf(entry),
  };
}

// --------------------------------------------------------------------------

const list = (await getJson("/catalog/apis")).apis;
console.log(`catalog: ${list.length} endpoints`);

const raw = await mapLimit(list, CONCURRENCY, (a) =>
  getJson(`/catalog/apis/${encodeURIComponent(a.api_id)}?expand=inputs`),
);

const entries = raw.map(normalize).sort((a, b) => a.apiId.localeCompare(b.apiId));

// --- guard: every media field must have a port binding -------------------
const unknown = new Map();
for (const e of entries) {
  for (const m of e.media) {
    if (!BINDINGS[m.field]) {
      if (!unknown.has(m.field)) unknown.set(m.field, []);
      unknown.get(m.field).push(e.apiId);
    }
  }
}
if (unknown.size) {
  console.error("\nERROR: catalog has media fields with no port binding.");
  console.error("Add them to server/src/pika-port-bindings.json, then re-run:\n");
  for (const [field, ids] of unknown) {
    console.error(`  ${field}  (${ids.length} endpoint(s), e.g. ${ids[0]})`);
  }
  process.exit(1);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify({ syncedAt: new Date().toISOString(), base: BASE, entries }, null, 2) + "\n",
);

// --- report --------------------------------------------------------------
const byCat = entries.reduce((a, e) => ((a[e.category] = (a[e.category] ?? 0) + 1), a), {});
console.log(`wrote ${entries.length} entries -> ${OUT}`);
console.log("  by category:", byCat);
const noPrice = entries.filter((e) => !e.pricing).map((e) => e.apiId);
if (noPrice.length) console.log(`  no output pricing (${noPrice.length}):`, noPrice.join(", "));
const needsJson = entries.filter((e) => e.requiredAdvanced.length);
if (needsJson.length) {
  console.log(`  require raw-JSON params (${needsJson.length}):`);
  for (const e of needsJson) console.log(`    ${e.apiId}: ${e.requiredAdvanced.join(", ")}`);
}
