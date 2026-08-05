import type {
  GraphNode,
  NodeType,
  OutputKind,
  PortIn,
  PortOut,
} from "./types.js";

// Typed ports per node type (spec §1). The kind of a port gates connections.
interface PortDef {
  inputs: { port: PortIn; kind: OutputKind; required: boolean }[];
  output?: { port: PortOut; kind: OutputKind }; // layout nodes (frame) have none
}

export const PORTS: Record<NodeType, PortDef> = {
  image_gen: {
    inputs: [
      { port: "ref_in", kind: "image", required: false },
      { port: "text_in", kind: "text", required: false }, // prompt from upstream text
    ],
    output: { port: "image_out", kind: "image" },
  },
  image_edit: {
    inputs: [
      { port: "image_in", kind: "image", required: true },
      { port: "ref_in", kind: "image", required: false },
      { port: "mask_in", kind: "image", required: false }, // inpainting mask (gpt-image-2, pikaswaps)
      { port: "text_in", kind: "text", required: false }, // prompt from upstream text
    ],
    output: { port: "image_out", kind: "image" },
  },
  // One node type covers every video-producing function in the catalog —
  // t2v / i2v / flf / r2v / v2v / extension / motion-control / avatar. Which
  // ports a given model actually needs comes from its generated schema, so
  // nothing is "required" here; the adapter refuses a mis-wired run *before*
  // it bills (a missing required field would otherwise be a paid no-op).
  video_gen: {
    inputs: [
      { port: "image_in", kind: "image", required: false }, // first frame (i2v / flf), or the inserted subject (pikadditions)
      { port: "last_frame_in", kind: "image", required: false }, // last frame (flf)
      { port: "ref_in", kind: "image", required: false }, // reference images (r2v)
      { port: "mask_in", kind: "image", required: false }, // region mask (pikaswaps)
      { port: "video_in", kind: "video", required: false }, // source clip (v2v / extension / motion-control / lipsync)
      { port: "ref_video_in", kind: "video", required: false }, // reference videos (r2v)
      { port: "audio_in", kind: "audio", required: false }, // driving audio (avatar / lipsync)
      { port: "ref_audio_in", kind: "audio", required: false }, // reference audio (Seedance 2.0 r2v)
      { port: "text_in", kind: "text", required: false }, // prompt from upstream text
    ],
    output: { port: "video_out", kind: "video" },
  },
  image_upload: {
    inputs: [],
    output: { port: "image_out", kind: "image" },
  },
  // a user-supplied video source (drag-dropped or picked) — exposes video_out
  video_upload: {
    inputs: [],
    output: { port: "video_out", kind: "video" },
  },
  // a user-supplied audio source (drag-dropped or picked) — exposes audio_out
  audio_upload: {
    inputs: [],
    output: { port: "audio_out", kind: "audio" },
  },
  video_upscale: {
    inputs: [{ port: "video_in", kind: "video", required: true }],
    output: { port: "video_out", kind: "video" },
  },
  // Anything that produces an audio track: TTS, sound effects, music, plus the
  // audio-in functions (speech-to-speech, voice isolation, dubbing).
  audio_gen: {
    inputs: [
      { port: "audio_in", kind: "audio", required: false }, // source voice (sts / isolation / dubbing)
      { port: "ref_audio_in", kind: "audio", required: false }, // reference tracks (seed-audio)
      { port: "video_in", kind: "video", required: false }, // dubbing accepts a video source
      { port: "image_in", kind: "image", required: false }, // seed-audio conditions on an image
      { port: "text_in", kind: "text", required: false },
    ],
    output: { port: "audio_out", kind: "audio" },
  },
  // Score an existing cut — the clip goes in, a music/SFX track comes out.
  // Pair it with av_mux to lay the result back over the picture.
  video_to_audio: {
    inputs: [
      { port: "video_in", kind: "video", required: true },
      { port: "text_in", kind: "text", required: false },
    ],
    output: { port: "audio_out", kind: "audio" },
  },
  // Speech -> text. Feeds note/doc/llm_text downstream.
  transcribe: {
    inputs: [{ port: "audio_in", kind: "audio", required: true }],
    output: { port: "text_out", kind: "text" },
  },
  // Pika's LLM catalog. The node prompt is the instruction; upstream text is
  // appended as reference material, never treated as the instruction itself.
  llm_text: {
    inputs: [{ port: "text_in", kind: "text", required: false }],
    output: { port: "text_out", kind: "text" },
  },
  // builtin/ffmpeg: put an audio track onto a video. Closes the scoring loop
  // video_gen -> video_to_audio -> av_mux without leaving the canvas.
  av_mux: {
    inputs: [
      { port: "video_in", kind: "video", required: true },
      { port: "audio_in", kind: "audio", required: true },
    ],
    output: { port: "video_out", kind: "video" },
  },
  // join clips A->B->… (ordered left-to-right by source node position)
  video_concat: {
    inputs: [{ port: "clip_in", kind: "video", required: true }],
    output: { port: "video_out", kind: "video" },
  },
  // extract one frame from a video at a chosen time -> image (builtin/ffmpeg)
  frame_extract: {
    inputs: [{ port: "video_in", kind: "video", required: true }],
    output: { port: "image_out", kind: "image" },
  },
  // text / knowledge nodes — usable in ANY project alongside media nodes.
  note: {
    // sources this note synthesizes (filled by the user or the agent)
    inputs: [{ port: "text_in", kind: "text", required: false }],
    output: { port: "text_out", kind: "text" },
  },
  doc: {
    inputs: [{ port: "text_in", kind: "text", required: false }],
    output: { port: "text_out", kind: "text" },
  },
  web_clip: {
    inputs: [],
    output: { port: "text_out", kind: "text" },
  },
  file_import: {
    inputs: [],
    output: { port: "text_out", kind: "text" },
  },
  // layout-only organizer: no ports, purely visual grouping.
  frame: {
    inputs: [],
  },
};

// Input ports that may receive multiple edges (the rest take a single source).
export const MULTI_INPUT_PORTS = new Set<PortIn>([
  "ref_in",
  "ref_video_in",
  "ref_audio_in",
  "clip_in",
  "text_in",
]);

export function outputKindOf(type: NodeType, port: PortOut): OutputKind | null {
  const out = PORTS[type].output;
  return out && out.port === port ? out.kind : null;
}

export function inputKindOf(type: NodeType, port: PortIn): OutputKind | null {
  const def = PORTS[type].inputs.find((i) => i.port === port);
  return def ? def.kind : null;
}

// kind-match validation (spec §1): connection valid only when source output kind
// equals target input kind. e.g. video_out -> image_in is rejected.
export function connectionValid(
  sourceNode: GraphNode,
  sourceHandle: PortOut,
  targetNode: GraphNode,
  targetHandle: PortIn,
): { ok: true } | { ok: false; reason: string } {
  const srcKind = outputKindOf(sourceNode.type, sourceHandle);
  if (!srcKind)
    return {
      ok: false,
      reason: `node ${sourceNode.id} (${sourceNode.type}) has no output port "${sourceHandle}"`,
    };
  const dstKind = inputKindOf(targetNode.type, targetHandle);
  if (!dstKind)
    return {
      ok: false,
      reason: `node ${targetNode.id} (${targetNode.type}) has no input port "${targetHandle}"`,
    };
  if (srcKind !== dstKind)
    return {
      ok: false,
      reason: `kind mismatch: ${sourceHandle} (${srcKind}) cannot feed ${targetHandle} (${dstKind})`,
    };
  return { ok: true };
}

export function requiredInputs(type: NodeType): PortIn[] {
  return PORTS[type].inputs.filter((i) => i.required).map((i) => i.port);
}
