import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nanoid } from "nanoid";
import { projectAssetsDir } from "./paths.js";
import type { OutputKind } from "./types.js";

const EXT: Record<OutputKind, string> = { image: "png", video: "mp4", audio: "mp3", text: "txt" };

function extFromContentType(ct: string | null, kind: OutputKind): string {
  if (!ct) return EXT[kind];
  // audio content types first — "audio/mp4"/"audio/webm" must not fall into the
  // video mp4/webm branches below.
  if (kind === "audio") {
    if (ct.includes("mpeg") || ct.includes("mp3")) return "mp3";
    if (ct.includes("wav")) return "wav";
    if (ct.includes("ogg")) return "ogg";
    if (ct.includes("flac")) return "flac";
    if (ct.includes("aac")) return "aac";
    if (ct.includes("mp4") || ct.includes("m4a")) return "m4a";
    if (ct.includes("webm")) return "webm";
    return EXT[kind];
  }
  if (ct.includes("svg")) return "svg";
  if (ct.includes("jpeg")) return "jpg";
  if (ct.includes("png")) return "png";
  if (ct.includes("webp")) return "webp";
  if (ct.includes("mp4")) return "mp4";
  if (ct.includes("webm")) return "webm";
  return EXT[kind];
}

// Download a (provider-side, often temporary) URL into the project's assets dir
// and return the local URL the server serves it from. Supports data: URLs too.
export async function downloadToAssets(
  url: string,
  kind: OutputKind,
  projectId: string,
  // Supplied by the adapter when the host is picky about headers (Pika serves
  // results from a CDN that rejects the API key and an API host that requires
  // it — the provider knows which, this module should not guess).
  headers?: Record<string, string>,
): Promise<{ localUrl: string; bytes: number }> {
  const dir = projectAssetsDir(projectId);
  await fs.mkdir(dir, { recursive: true });

  let buf: Buffer;
  let ext = EXT[kind];

  if (url.startsWith("data:")) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!m) throw new Error("invalid data url");
    const ct = m[1] ?? null;
    const isB64 = !!m[2];
    buf = isB64
      ? Buffer.from(m[3], "base64")
      : Buffer.from(decodeURIComponent(m[3]), "utf8");
    ext = extFromContentType(ct, kind);
  } else {
    const res = await fetch(url, headers ? { headers } : undefined);
    if (!res.ok) throw new Error(`download failed ${res.status} for ${url}`);
    ext = extFromContentType(res.headers.get("content-type"), kind);
    buf = Buffer.from(await res.arrayBuffer());
  }

  const name = `${nanoid()}.${ext}`;
  await fs.writeFile(path.join(dir, name), buf);
  return { localUrl: `/assets/${projectId}/${name}`, bytes: buf.length };
}

// Stream a raw request body (binary upload) straight to the project's assets
// dir without buffering the whole file in memory. Used for large videos that
// would otherwise blow the JSON body limit when sent as base64 data URLs.
export async function streamToAssets(
  stream: Readable,
  ext: string,
  projectId: string,
): Promise<{ localUrl: string; bytes: number }> {
  const dir = projectAssetsDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const name = `${nanoid()}.${ext.replace(/^\./, "")}`;
  const full = path.join(dir, name);
  await pipeline(stream, createWriteStream(full));
  const { size } = await fs.stat(full);
  return { localUrl: `/assets/${projectId}/${name}`, bytes: size };
}

export async function saveBytesToAssets(
  bytes: Buffer,
  ext: string,
  projectId: string,
): Promise<string> {
  const dir = projectAssetsDir(projectId);
  await fs.mkdir(dir, { recursive: true });
  const name = `${nanoid()}.${ext.replace(/^\./, "")}`;
  await fs.writeFile(path.join(dir, name), bytes);
  return `/assets/${projectId}/${name}`;
}
