import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getEntry, getModel, isOpaqueUnit } from "../registry.js";
import type { CatalogEntry, CatalogMediaField, CatalogPricing } from "../registry.js";
import { resolveAssetPath } from "../paths.js";
import { probeDuration, shrinkForUpload } from "../ffmpeg.js";
import bindingsFile from "../pika-port-bindings.json" with { type: "json" };
import type {
  CostEstimate,
  OutputKind,
  ParamField,
  PortIn,
  ProviderAdapter,
  ProviderRunArgs,
  RawOutput,
  ResolvedInput,
} from "../types.js";

// ---------------------------------------------------------------------------
// Pika adapter
//
// One adapter for all 109 endpoints. Pika's catalog publishes each endpoint's
// JSON Schema (with `media_kinds` annotations on URL fields) and its price
// tiers, so requests, validation and cost all fall out of generated data —
// there is deliberately no per-model branching in this file.
//
// Two surfaces:
//   media  POST /v1/media/{vendor}/{model}/{function} -> poll -> content url
//   llm    POST /v1/chat/completions (OpenAI-compatible, synchronous)
// ---------------------------------------------------------------------------

const BASE = process.env.PIKA_API_BASE ?? "https://api.dev.pika.art";
const POLL_INTERVAL_MS = 3000;
// 180 min, not 20: Wan 3.0 early access runs 30-60+ min per job, and the
// provider's own lifetime cap was observed to kill a job only at ~90 min
// (2026-08-21, 30s/1080p omni-video). Our poll must outlive the provider's
// verdict either way — giving up early orphans a job that keeps running AND
// billing on Pika's side; a genuinely dead job exits the loop via its status.
const POLL_TIMEOUT_MS = 180 * 60 * 1000;
const FIELD_PORTS_RAW = bindingsFile.fields as Record<string, unknown>;
// The plain view: tagged-union fields expose their ports here too, so every
// existing lookup (port order, consumed-port accounting) keeps working.
const FIELD_PORTS = Object.fromEntries(
  Object.entries(FIELD_PORTS_RAW).map(([k, v]) => [
    k,
    (Array.isArray(v) ? v : Object.keys((v as { ports: Record<string, string> }).ports)) as PortIn[],
  ]),
) as Record<string, PortIn[]>;

// Raw JSON escape hatch. A couple of endpoints take structured arrays
// (dialogue turns, omni-video contents) that the param widgets cannot express.
export const RAW_JSON_PARAM = "_json";

function key(): string {
  const k = process.env.PIKA_API_KEY;
  if (!k) throw new Error("PIKA_API_KEY is not set（アプリメニュー「設定（APIキー）を開く」で設定してください）");
  return k;
}

async function pika<T = any>(
  method: string,
  apiPath: string,
  body?: unknown,
  retries = 4,
): Promise<T> {
  let last: Error | null = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    // A network-level failure throws out of fetch() rather than returning a
    // status, so it has to be caught here — otherwise one transient blip during
    // a ten-minute video poll kills a job that is running (and billing) fine.
    let res: Response;
    let text: string;
    try {
      res = await fetch(`${BASE}${apiPath}`, {
        method,
        headers: {
          "X-API-Key": key(),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      text = await res.text();
    } catch (err) {
      last = new Error(`Pika ${apiPath} network error: ${(err as Error).message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      continue;
    }
    if (res.ok) {
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`Pika ${apiPath} non-JSON response: ${text.slice(0, 200)}`);
      }
    }
    // 4xx other than 429 are our own malformed request — retrying just wastes time.
    if (res.status < 500 && res.status !== 429) {
      let msg = text.slice(0, 400);
      try {
        const j = JSON.parse(text);
        msg = j?.error?.message ?? j?.message ?? j?.detail ?? msg;
      } catch {
        /* keep the raw body */
      }
      throw new Error(`Pika ${apiPath} HTTP ${res.status}: ${msg}`);
    }
    last = new Error(`Pika ${apiPath} HTTP ${res.status}: ${text.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw last ?? new Error(`Pika ${apiPath} failed`);
}

// --------------------------------------------------------------------- uploads

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
};

// Pika rejects an upload larger than this with a bare `413 file too large`,
// before it hands back a presigned URL. Measured against the live API on
// 2026-09-02: 104,857,600 bytes is accepted, 104,857,601 is not, for video,
// audio and image alike. A 30s 1080p Wan 3.0 clip lands around 207 MiB — this
// is not an edge case, it is the normal size of a long generated clip.
const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

// Canvas assets are written once under a nanoid filename and never mutated, so
// the local URL is a safe cache key. Without this, re-running a node would
// re-upload the same multi-megabyte clip on every attempt.
const uploadCache = new Map<string, string>();

/**
 * Local /assets/* URLs become Pika-hosted URLs; public URLs pass through.
 *
 * `shrinkable` says the receiving model only reads this clip and returns
 * something else (a score, a transcript) — then an oversized video may be
 * re-encoded down to fit. It is false wherever the input's pixels carry into
 * the output, because quietly downscaling someone's master before a v2v pass
 * is a worse failure than refusing: they would never see it happen.
 */
async function toPikaUrl(url: string, shrinkable = false): Promise<string> {
  if (/^https?:\/\//.test(url) && !/localhost|127\.0\.0\.1/.test(url)) return url;
  const cacheKey = shrinkable ? `${url}|shrunk` : url;
  const cached = uploadCache.get(cacheKey);
  if (cached) return cached;

  let filePath = resolveAssetPath(url);
  let tempProxy: string | null = null;
  // stat, not readFile: a 200 MiB buffer allocated only to learn a number the
  // filesystem already knows, and then thrown away on rejection.
  const size = (await fs.stat(filePath)).size;
  if (size > UPLOAD_MAX_BYTES) {
    if (!shrinkable) {
      throw new Error(
        `${path.basename(filePath)} は ${mib(size)} で、Pika のアップロード上限 ${mib(UPLOAD_MAX_BYTES)} を超えています。` +
          `このモデルは入力の画がそのまま出力に載るため、勝手に再エンコードして画質を落とすことはしません。` +
          `動画トリムで短くするか、解像度・ビットレートを落としたものを取り込んでから繋いでください。`,
      );
    }
    tempProxy = path.join(os.tmpdir(), `pika-proxy-${Date.now()}-${path.basename(filePath)}`);
    await shrinkForUpload(filePath, tempProxy, UPLOAD_MAX_BYTES);
    const proxySize = (await fs.stat(tempProxy)).size;
    if (proxySize > UPLOAD_MAX_BYTES) {
      await fs.rm(tempProxy, { force: true });
      throw new Error(
        `${path.basename(filePath)}（${mib(size)}）を上限 ${mib(UPLOAD_MAX_BYTES)} 以下に再エンコードできませんでした` +
          `（${mib(proxySize)} まで。尺が長すぎます）。動画トリムで分割してから繋いでください。`,
      );
    }
    // Analysis-only, so this never reaches the output — but say it out loud
    // rather than let a silent re-encode look like the original was sent.
    console.log(
      `[pika] ${path.basename(filePath)} ${mib(size)} > ${mib(UPLOAD_MAX_BYTES)}: ` +
        `解析用に ${mib(proxySize)} へ再エンコードして送信します（出力は音声/テキストなので画質に影響しません）`,
    );
    filePath = tempProxy;
  }

  const buf = await fs.readFile(filePath);
  const ext = (path.extname(filePath).slice(1) || "png").toLowerCase();
  const contentType = MIME[ext] ?? "application/octet-stream";

  const res = await pika<{ upload_url: string; url: string }>("POST", "/v1/media/uploads", {
    content_type: contentType,
    size_bytes: buf.length,
  });
  const put = await fetch(res.upload_url, {
    method: "PUT",
    headers: { "content-type": contentType },
    body: new Uint8Array(buf),
  });
  if (!put.ok) {
    if (tempProxy) await fs.rm(tempProxy, { force: true });
    throw new Error(`Pika upload PUT failed (${put.status}) for ${path.basename(filePath)}`);
  }
  if (tempProxy) await fs.rm(tempProxy, { force: true });

  uploadCache.set(cacheKey, res.url);
  return res.url;
}

// ---------------------------------------------------------------- request body

const PORT_LABEL: Record<PortIn, string> = {
  image_in: "画像入力",
  ref_in: "参照画像",
  last_frame_in: "最終フレーム",
  mask_in: "マスク",
  video_in: "動画入力",
  ref_video_in: "参照動画",
  audio_in: "音声入力",
  ref_audio_in: "参照音声",
  clip_in: "クリップ",
  text_in: "テキスト",
};

/** A tagged-union media field: the port a URL comes from decides its role. */
interface UnionBinding {
  roleField: string;
  urlField: string;
  ports: Record<string, string>;
}

function unionBindingFor(field: string): UnionBinding | null {
  const b = FIELD_PORTS_RAW[field];
  return b && !Array.isArray(b) ? (b as UnionBinding) : null;
}

function portsFor(field: string): PortIn[] {
  const ports = FIELD_PORTS[field];
  if (!ports) {
    // sync-catalog.mjs refuses to emit an unmapped field, so reaching this means
    // the snapshot was edited by hand. Fail rather than silently ignore inputs.
    throw new Error(
      `Pika フィールド "${field}" にポート割り当てがありません（server/src/pika-port-bindings.json を更新してください）`,
    );
  }
  return ports;
}

/** URLs connected to `ports`, in port order, filtered to kinds the field accepts. */
function urlsFor(inputs: ResolvedInput[], ports: PortIn[], kinds: OutputKind[]): string[] {
  const out: string[] = [];
  for (const p of ports) {
    for (const i of inputs) {
      if (i.port === p && kinds.includes(i.kind) && i.url) out.push(i.url);
    }
  }
  return out;
}

function coerce(value: unknown, field: ParamField): unknown {
  const s = String(value);
  switch (field.valueType) {
    case "boolean":
      return s === "on" || s === "true";
    case "integer":
      return Math.round(Number(s));
    case "number":
      return Number(s);
    case "loose":
      // Unions like Seedance's duration ("4".."15" or "auto") decide per value.
      return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : s;
    default:
      return s;
  }
}

/**
 * Assemble the request body from the node's prompt, params and wired inputs.
 *
 * Everything that can go wrong is checked HERE, before the POST — a request
 * that reaches Pika and succeeds is billed even if it quietly ignored the
 * inputs the user wired up.
 */
export function buildBody(
  entry: CatalogEntry,
  prompt: string,
  params: Record<string, unknown>,
  inputs: ResolvedInput[],
): Record<string, unknown> {
  const body: Record<string, unknown> = {};

  // --- free text -----------------------------------------------------------
  if (entry.textField) {
    const text = (prompt ?? "").trim();
    if (entry.textMaxLength && text.length > entry.textMaxLength) {
      throw new Error(
        `${entry.name} のテキスト上限は ${entry.textMaxLength} 文字です（現在 ${text.length} 文字）。実行前に削ってください。`,
      );
    }
    if (text) body[entry.textField] = text;
    else if (entry.requiredFields.includes(entry.textField)) {
      throw new Error(`${entry.name} にはプロンプトが必要です（${entry.textField}）。`);
    }
  }

  // --- media ---------------------------------------------------------------
  const consumed = new Set<PortIn>();
  for (const m of entry.media) {
    const ports = portsFor(m.field);
    const urls = urlsFor(inputs, ports, m.kinds);
    ports.forEach((p) => consumed.add(p));

    if (!urls.length) {
      if (m.required) {
        const where = ports.map((p) => PORT_LABEL[p]).join(" / ");
        throw new Error(
          `${entry.name} は「${where}」への接続が必須です（${m.field}）。接続せずに実行すると課金だけ発生します。`,
        );
      }
      continue;
    }
    const union = unionBindingFor(m.field);
    if (union) {
      // Each connected input becomes one item tagged with the role of the port
      // it arrived on. Order follows port order, then edge order.
      const items: Record<string, unknown>[] = [];
      for (const port of ports) {
        const role = union.ports[port];
        if (!role) continue;
        for (const i of inputs) {
          if (i.port !== port || i.kind === "text" || !i.url) continue;
          if (!m.kinds.includes(i.kind)) continue;
          items.push({ [union.roleField]: role, [union.urlField]: i.url });
        }
      }
      // The prompt travels inside the same array for these models rather than
      // in a top-level text field.
      const text = (prompt ?? "").trim();
      if (text) items.unshift({ [union.roleField]: "prompt", text });
      if (!items.length && m.required)
        throw new Error(
          `${entry.name} は最低1つの入力が必要です（${m.field}）。プロンプトかメディアを与えてください。`,
        );
      if (items.length) body[m.field] = items;
      continue;
    }

    if (m.array) {
      const max = m.maxItems ?? urls.length;
      if (urls.length > max) {
        throw new Error(
          `${entry.name} の ${m.field} は最大 ${max} 件です（現在 ${urls.length} 件）。超過分を外してください。`,
        );
      }
      if (m.minItems && urls.length < m.minItems) {
        throw new Error(
          `${entry.name} の ${m.field} は最低 ${m.minItems} 件必要です（現在 ${urls.length} 件）。`,
        );
      }
      if (m.itemField) {
        // Object-shaped items (FLUX 3 keyframes). Each positioning sibling is
        // supplied as one comma-separated param; the schema requires it on
        // every entry or on none, so a partial list is rejected rather than
        // silently padded.
        const items: Record<string, unknown>[] = urls.map((u) => ({ [m.itemField!]: u }));
        for (const ex of m.itemExtras ?? []) {
          const raw = params[`${m.field}_${ex.key}`];
          const list = String(raw ?? "")
            .split(",")
            .map((v) => v.trim())
            .filter(Boolean);
          if (!list.length) continue;
          if (list.length !== items.length) {
            throw new Error(
              `${entry.name}: ${m.field}_${ex.key} は ${items.length} 件（接続したメディアと同数）で指定してください（現在 ${list.length} 件）。全件に付けるか、空欄にするかのどちらかです。`,
            );
          }
          list.forEach((v, i) => {
            const n = Number(v);
            items[i][ex.key] = Number.isFinite(n) ? n : v;
          });
        }
        body[m.field] = items;
      } else {
        body[m.field] = urls;
      }
    } else {
      if (urls.length > 1) {
        const where = ports.map((p) => PORT_LABEL[p]).join(" / ");
        throw new Error(
          `${entry.name} の ${m.field} は1つだけ受け付けます（「${where}」に ${urls.length} 件接続されています）。余分を外してください。`,
        );
      }
      body[m.field] = urls[0];
    }
  }

  // Media wired to a port this model has no field for would be dropped in
  // silence — and still billed. Stop instead, and say which port to unwire.
  const ignored = inputs.filter(
    (i) => i.kind !== "text" && i.url && !consumed.has(i.port),
  );
  if (ignored.length) {
    const ports = [...new Set(ignored.map((i) => PORT_LABEL[i.port]))].join(" / ");
    throw new Error(
      `${entry.name} は「${ports}」を使いません。接続を外すか、その入力を受け取るモデルに変更してください` +
        `（このまま実行すると入力は無視され、課金だけ発生します）。`,
    );
  }

  // --- params --------------------------------------------------------------
  // Params synthesised for object-array media (`keyframes_at_s`) exist only to
  // build the item objects above. They are not fields of the endpoint, so
  // sending them on would trip additionalProperties.
  const synthetic = new Set(
    entry.media.flatMap((m) => (m.itemExtras ?? []).map((ex) => `${m.field}_${ex.key}`)),
  );
  for (const f of entry.params) {
    if (synthetic.has(f.key)) continue;
    const raw = params[f.key];
    // "" is the canvas's "leave unset" — omit so Pika applies its own default.
    if (raw === undefined || raw === null || raw === "") {
      // …except when the endpoint declares it required. Omitting it is a
      // guaranteed 422, so say which field is missing instead of letting the
      // API answer with a validation error the user has to decode.
      if (f.required) {
        throw new Error(
          `${entry.name} には「${f.label}」（${f.key}）の指定が必要です` +
            `${f.description ? ` — ${f.description}` : ""}。パラメータから設定してください。`,
        );
      }
      continue;
    }
    body[f.key] = coerce(raw, f);
  }

  // --- raw JSON escape hatch ----------------------------------------------
  const rawJson = params[RAW_JSON_PARAM];
  if (typeof rawJson === "string" && rawJson.trim()) {
    let extra: unknown;
    try {
      extra = JSON.parse(rawJson);
    } catch (err) {
      throw new Error(`詳細JSON が JSON として読めません: ${(err as Error).message}`);
    }
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) {
      throw new Error("詳細JSON はオブジェクト（{ ... }）で書いてください。");
    }
    Object.assign(body, extra);
  }

  // Structured params the widgets cannot render must come from the raw JSON.
  const missing = entry.requiredAdvanced.filter((k) => body[k] === undefined);
  if (missing.length) {
    const hints = entry.advanced
      .filter((a) => missing.includes(a.key))
      .map((a) => `${a.key}: ${a.description ?? a.label}`)
      .join(" / ");
    throw new Error(
      `${entry.name} には構造化パラメータが必要です（${hints}）。パラメータの「詳細JSON」に指定してください。`,
    );
  }

  return body;
}

// ------------------------------------------------------------------- pricing

/** Count params some image models use to ask for more than one output. */
const COUNT_KEYS = ["n", "num_images", "max_images", "count", "num_outputs"];

function norm(v: unknown): string {
  const s = String(v ?? "").toLowerCase();
  if (s === "true") return "on";
  if (s === "false") return "off";
  return s;
}

/**
 * Pick the price tier matching the node's params. Tier specs are partial
 * ({resolution:"1080p", audio:"on"}), so score by matching keys and break ties
 * upward — quoting under the real price is worse than quoting over it.
 */
function pickTier(pricing: CatalogPricing, params: Record<string, unknown>) {
  let best = pricing.tiers[0];
  let bestScore = -1;
  // A tier can name a dimension the params express as a boolean instead: FLUX 3
  // prices on `mode: draft|standard` while the endpoint exposes `draft: on|off`.
  // Collect the values that exist as boolean params so such a tier can still be
  // matched exactly, rather than falling back to "ティア推定" and quoting the
  // wrong price (720p draft is $0.054, the standard tier $0.153).
  const flagValues = new Set<string>();
  for (const t of pricing.tiers)
    for (const v of Object.values(t.spec))
      if (params[String(v)] !== undefined) flagValues.add(norm(v));
  const activeFlag = [...flagValues].find((v) => {
    const got = norm(params[v]);
    return got !== "" && got !== "off" && got !== "false";
  });

  for (const t of pricing.tiers) {
    const keys = Object.keys(t.spec);
    let score = 0;
    for (const k of keys) {
      const want = norm(t.spec[k]);
      const got = norm(params[k]);
      if (got === "" && flagValues.size) {
        // The params have no key `k`; decide from the boolean flags. A tier
        // naming a flag matches when that flag is on; every other tier value
        // for this dimension is the baseline, matching when no flag is on.
        if (flagValues.has(want) ? activeFlag === want : activeFlag === undefined) score++;
        continue;
      }
      // Tiers say audio on/off while some models expose audio as "native"/"off";
      // treat any set, non-"off" value as "on" so those still line up.
      if (got === want || (want === "on" && got !== "" && got !== "off")) score++;
    }
    const exact = keys.length > 0 && score === keys.length;
    const rank = exact ? 1000 + score : score;
    if (rank > bestScore || (rank === bestScore && t.usd > best.usd)) {
      best = t;
      bestScore = rank;
    }
  }
  return { tier: best, matched: bestScore >= 1000 };
}

function durationFor(entry: CatalogEntry, params: Record<string, unknown>): { sec: number; assumed: boolean } {
  const raw = params.duration ?? params.duration_seconds;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return { sec: n, assumed: false };
  // Unset or "auto": fall back to the schema's own minimum and say so, rather
  // than inventing a mid-range number the user never chose.
  const field = entry.params.find((f) => f.key === "duration" || f.key === "duration_seconds");
  const opts = (field?.options ?? []).map(Number).filter((v) => Number.isFinite(v) && v > 0);
  const min = field?.min ?? (opts.length ? Math.min(...opts) : 5);
  return { sec: min, assumed: true };
}

export function estimate(
  modelId: string,
  params: Record<string, unknown>,
  prompt = "",
): CostEstimate {
  const entry = getEntry(modelId);
  const pricing = entry?.pricing;
  if (!entry || !pricing || !pricing.tiers.length)
    return { amount: 0, currency: "USD", note: "価格情報なし（実行後に請求額を確認してください）" };

  const { tier, matched } = pickTier(pricing, params);
  const unitPrice = tier.usd;
  const spec = Object.entries(tier.spec)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const tierNote = spec ? `${spec}${matched ? "" : " ※ティア推定"}` : "";

  if (isOpaqueUnit(pricing.unit)) {
    // Metered per million output tokens with no published tokens-per-second or
    // tokens-per-pixel mapping. A number here would be fiction.
    return {
      amount: 0,
      currency: "USD",
      metered: true,
      note: `事前見積り不可: $${unitPrice} / 1M ${pricing.unit}（生成量が事前に判りません）${tierNote ? ` · ${tierNote}` : ""}`,
    };
  }

  switch (pricing.unit) {
    case "second":
    case "output_second": {
      const { sec, assumed } = durationFor(entry, params);
      return {
        amount: Number((unitPrice * sec).toFixed(3)),
        currency: "USD",
        note: `$${unitPrice}/秒 × ${sec}秒${assumed ? "（尺未指定のため最短で試算・実際はこれ以上）" : ""}${tierNote ? ` · ${tierNote}` : ""}`,
      };
    }
    case "image": {
      const key = COUNT_KEYS.find((k) => Number(params[k]) > 0);
      const n = key ? Number(params[key]) : 1;
      return {
        amount: Number((unitPrice * n).toFixed(3)),
        currency: "USD",
        note: `$${unitPrice}/枚 × ${n}枚${tierNote ? ` · ${tierNote}` : ""}`,
      };
    }
    case "character": {
      const chars = prompt.trim().length;
      const per = pricing.quantity || 1000;
      return {
        amount: Number(((unitPrice * chars) / per).toFixed(3)),
        currency: "USD",
        note: `$${unitPrice}/${per}字 × ${chars}字${tierNote ? ` · ${tierNote}` : ""}`,
      };
    }
    case "minute":
      // Billed on the *input* clip's length, which this (synchronous) estimate
      // cannot measure. Quote the rate and be explicit about the multiplier.
      return {
        amount: 0,
        currency: "USD",
        note: `$${unitPrice}/分 × 入力動画の長さ（尺に比例・事前計測なし）${tierNote ? ` · ${tierNote}` : ""}`,
      };
    case "request":
      return {
        amount: unitPrice,
        currency: "USD",
        note: `$${unitPrice}/回${tierNote ? ` · ${tierNote}` : ""}`,
      };
    default:
      return {
        amount: unitPrice,
        currency: "USD",
        note: `$${unitPrice} / ${pricing.unit}${tierNote ? ` · ${tierNote}` : ""}`,
      };
  }
}

// ------------------------------------------------------- measured duration

/**
 * Fill `duration_seconds` from the connected media.
 *
 * The transcription / voice-isolation / speech-to-speech / dubbing endpoints
 * all require this field, and what they want is the length of the clip you are
 * handing them — a number the canvas can measure but the user would have to
 * look up by hand. Left alone it falls back to the schema's minimum (0.1s for
 * Whisper), which either truncates the job or misbills it.
 *
 * Only applied when the value is still the generated default, so an explicit
 * setting always wins. Endpoints where `duration_seconds` means the *output*
 * length instead (text-to-sound-v2 has no media input) are untouched.
 */
async function withMeasuredDuration(
  entry: CatalogEntry,
  spec: { defaults: Record<string, unknown> },
  params: Record<string, unknown>,
  inputs: ResolvedInput[],
): Promise<Record<string, unknown>> {
  const field = entry.params.find((f) => f.key === "duration_seconds" && f.required);
  if (!field) return params;
  if (!entry.media.some((m) => m.kinds.includes("audio") || m.kinds.includes("video"))) return params;

  const current = params.duration_seconds;
  const isDefault =
    current === undefined || current === null || current === "" ||
    Number(current) === Number(spec.defaults.duration_seconds);
  if (!isDefault) return params;

  const source = inputs.find((i) => (i.kind === "audio" || i.kind === "video") && i.url);
  if (!source) return params;

  let seconds = 0;
  try {
    seconds = await probeDuration(resolveAssetPath(source.url));
  } catch {
    return params; // not a local asset (or no ffprobe) — leave the default alone
  }
  if (!seconds) return params;

  // Round up: a value under the true length risks a truncated transcript.
  let value = Math.ceil(seconds * 100) / 100;
  if (typeof field.max === "number") value = Math.min(value, field.max);
  return { ...params, duration_seconds: value };
}

// ----------------------------------------------------------------- media jobs

interface PikaJob {
  id: string;
  status: "queued" | "running" | "completed" | "failed";
  output?: { media_type?: string; [k: string]: any };
  error?: unknown;
  // Metered models are billed on counters only the provider knows. Whatever it
  // reports is kept verbatim so a real charge can be reconciled later; the
  // shape is not guaranteed and is deliberately not parsed here.
  usage?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Pull whatever usage counters a completed job carries, wherever they sit. */
function usageOf(job: PikaJob): Record<string, unknown> | undefined {
  for (const key of ["usage", "metrics", "billing", "consumption"]) {
    const v = (job as Record<string, unknown>)[key];
    if (v && typeof v === "object") return v as Record<string, unknown>;
  }
  const out = job.output as Record<string, unknown> | undefined;
  if (out) {
    for (const key of ["usage", "metrics", "billing"]) {
      const v = out[key];
      if (v && typeof v === "object") return v as Record<string, unknown>;
    }
  }
  return undefined;
}

/**
 * A failed job's `error` is sometimes a string and sometimes a structured
 * object. Interpolating it directly yields "[object Object]", which hides the
 * only diagnosis the user gets for a generation that did not happen.
 */
function describeError(err: unknown): string {
  if (err == null) return "unknown";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const o = err as Record<string, unknown>;
    for (const k of ["message", "detail", "reason", "code", "error"]) {
      const v = o[k];
      if (typeof v === "string" && v.trim()) {
        const extra = typeof o.code === "string" && o.code !== v ? ` (${o.code})` : "";
        return v + extra;
      }
    }
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

async function waitForJob(id: string): Promise<PikaJob> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await pika<PikaJob>("GET", `/v1/media/jobs/${encodeURIComponent(id)}`);
    if (job.status === "completed") return job;
    if (job.status === "failed") throw new Error(`Pika job failed: ${describeError(job.error)}`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Pika job ${id} timed out after ${POLL_TIMEOUT_MS / 60000} minutes`);
}

/**
 * The result URL. `output.<media_type>.url` is the documented shape, but the
 * per-model docs are templated and not all of them describe their real payload
 * (transcription is documented as if it returned audio), so fall back to the
 * dedicated content endpoint whenever the inline shape is not what we expect.
 */
async function resultUrl(job: PikaJob): Promise<string> {
  const out = job.output;
  if (out) {
    const direct = out.media_type ? out[out.media_type]?.url : undefined;
    if (typeof direct === "string") return direct;
    for (const v of Object.values(out)) {
      if (v && typeof v === "object" && typeof (v as any).url === "string") return (v as any).url;
    }
  }
  const res = await pika<{ url?: string }>("GET", `/v1/media/jobs/${encodeURIComponent(job.id)}/content`);
  if (!res?.url) throw new Error(`Pika job ${job.id} completed without a result url`);
  return res.url;
}

/**
 * Results are served from two hosts with opposite requirements: cdn.pika.art
 * rejects requests carrying the API key, while the API host requires it. Both
 * reject a default programmatic user-agent. The core downloader is handed these
 * headers rather than guessing.
 */
function fetchHeadersFor(url: string): Record<string, string> {
  const browserUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36";
  if (url.includes("cdn.pika.art")) return { "user-agent": browserUa };
  if (url.startsWith(BASE)) return { "user-agent": browserUa, "X-API-Key": key() };
  return { "user-agent": browserUa };
}

/** Text results (transcription) arrive as a file; inline it for downstream nodes. */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: fetchHeadersFor(url) });
  if (!res.ok) throw new Error(`Pika result fetch failed (${res.status})`);
  const body = await res.text();
  try {
    const j = JSON.parse(body);
    if (typeof j === "string") return j;
    for (const k of ["text", "transcript", "transcription", "content"]) {
      if (typeof j?.[k] === "string") return j[k];
    }
    if (Array.isArray(j?.segments)) {
      const joined = j.segments.map((s: any) => s?.text ?? "").join("");
      if (joined.trim()) return joined;
    }
    return JSON.stringify(j, null, 2);
  } catch {
    return body; // plain text already
  }
}

// ------------------------------------------------------------------- llm chat

/**
 * Every LLM vendor in the catalog answers on the OpenAI-compatible surface —
 * verified against anthropic / openai / google / z-ai / moonshotai / deepseek,
 * each of which validated the body rather than rejecting the model id.
 */
async function runChat(
  entry: CatalogEntry,
  prompt: string,
  params: Record<string, unknown>,
  inputs: ResolvedInput[],
): Promise<RawOutput[]> {
  const instruction = (prompt ?? "").trim();
  if (!instruction) throw new Error("プロンプトが空です。");
  // Upstream text is reference material, not instruction — same convention as
  // the agent_task node, so a wired-up note cannot hijack the request.
  const refs = inputs
    .filter((i) => i.kind === "text" && i.text?.trim())
    .map((i) => i.text!.trim());
  const content = refs.length
    ? `${instruction}\n\n--- 参考情報（上流ノード） ---\n${refs.join("\n\n---\n\n")}`
    : instruction;

  const body: Record<string, unknown> = {
    model: entry.apiId,
    messages: [{ role: "user", content }],
  };
  for (const f of entry.params) {
    const raw = params[f.key];
    if (raw === undefined || raw === null || raw === "") continue;
    body[f.key] = coerce(raw, f);
  }
  // 8192, not 4096: a six-cut shot list in Japanese runs 4–6k tokens, and a
  // truncated storyboard poisons every downstream node without any error.
  if (body.max_tokens === undefined) body.max_tokens = 8192;

  const res = await pika<any>("POST", "/v1/chat/completions", body);
  const text = res?.choices?.[0]?.message?.content;
  if (typeof text !== "string" || !text.trim())
    throw new Error(`Pika chat returned no text: ${JSON.stringify(res).slice(0, 200)}`);
  return [{ kind: "text", url: "", text }];
}

// -------------------------------------------------------------------- adapter

export const pikaAdapter: ProviderAdapter = {
  id: "pika",

  supports(model) {
    return model.startsWith("pika/");
  },

  estimateCost(model, params, _inputs, prompt) {
    return estimate(model, params, prompt);
  },

  async run(model, args: ProviderRunArgs) {
    const spec = getModel(model);
    const entry = getEntry(model);
    if (!spec || !entry) throw new Error(`unknown model ${model}`);

    if (entry.category === "llm") {
      const est = estimate(model, args.params, args.prompt);
      return {
        outputs: await runChat(entry, args.prompt, args.params, args.inputs),
        cost: est.metered ? null : est.amount,
      };
    }

    const params = await withMeasuredDuration(entry, spec, args.params, args.inputs);

    // Validate against the local wiring first. Every guard depends only on
    // which ports carry something, so running it before the uploads means a
    // mis-wired node fails instantly instead of after pushing a 50MB clip.
    buildBody(entry, args.prompt, params, args.inputs);

    // Then upload local assets, preserving each input's port identity so the
    // body builder can still tell a reference from a first frame.
    // A video the model only listens to or reads (scoring, transcription) may be
    // re-encoded to clear Pika's upload cap; one that becomes the output must not.
    const analysesVideo = spec.kind !== "video";
    const resolved: ResolvedInput[] = await Promise.all(
      args.inputs.map(async (i) =>
        i.kind === "text"
          ? i
          : { ...i, url: await toPikaUrl(i.url, i.kind === "video" && analysesVideo) },
      ),
    );

    const body = buildBody(entry, args.prompt, params, resolved);
    const submitted = await pika<{ id?: string }>(entry.method, entry.path, body);
    if (!submitted?.id) throw new Error(`Pika did not return a job id: ${JSON.stringify(submitted).slice(0, 200)}`);

    const job = await waitForJob(submitted.id);
    const url = await resultUrl(job);

    const outputs: RawOutput[] =
      spec.kind === "text"
        ? [{ kind: "text", url: "", text: await fetchText(url) }]
        : [{ kind: spec.kind, url, fetchHeaders: fetchHeadersFor(url) }];

    // A metered model reports null, not 0 — the charge is real, we just cannot
    // derive it locally. Recording 0 made totals silently under-report by the
    // whole token-billed share of a project.
    const est = estimate(model, args.params, args.prompt);
    return {
      outputs,
      cost: est.metered ? null : est.amount,
      usage: usageOf(job),
    };
  },
};

// re-exported for the media-field type used above
export type { CatalogMediaField };
