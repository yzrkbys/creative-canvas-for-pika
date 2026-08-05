import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

// Resolve a binary: explicit env override, then common install locations, then PATH.
function findBin(name: string, envVar: string): string {
  const env = process.env[envVar];
  if (env) return env;
  for (const c of [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`])
    if (existsSync(c)) return c;
  return name; // fall back to PATH
}

const FFMPEG = findBin("ffmpeg", "PIKA_CANVAS_FFMPEG");
const FFPROBE = findBin("ffprobe", "PIKA_CANVAS_FFPROBE");

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      reject(
        new Error(
          `${bin} の起動に失敗しました（インストール済みか確認してください）: ${e.message}`,
        ),
      ),
    );
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`${bin} failed: ${err.slice(-400)}`)),
    );
  });
}

export async function probeSize(file: string): Promise<{ w: number; h: number }> {
  const out = await run(FFPROBE, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "csv=p=0:s=x",
    file,
  ]);
  const [w, h] = out.trim().split("x").map(Number);
  return { w: w || 1280, h: h || 720 };
}

// Concatenate clips in order into a single mp4. Clips are scaled+padded to the
// first clip's frame so mixed resolutions/aspect ratios join cleanly (no audio).
export async function concatVideos(inputs: string[], outPath: string): Promise<void> {
  const { w, h } = await probeSize(inputs[0]);
  const args: string[] = [];
  for (const f of inputs) args.push("-i", f);
  let filter = "";
  inputs.forEach((_, i) => {
    filter +=
      `[${i}:v]scale=${w}:${h}:force_original_aspect_ratio=decrease,` +
      `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30[v${i}];`;
  });
  filter += inputs.map((_, i) => `[v${i}]`).join("") + `concat=n=${inputs.length}:v=1:a=0[out]`;
  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[out]",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-y",
    outPath,
  );
  await run(FFMPEG, args);
}

// Duration in seconds of a media file (0 if unknown).
export async function probeDuration(file: string): Promise<number> {
  try {
    const out = await run(FFPROBE, [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "csv=p=0",
      file,
    ]);
    const d = Number(out.trim());
    return Number.isFinite(d) && d > 0 ? d : 0;
  } catch {
    return 0;
  }
}

// Lay an audio track over a video, replacing whatever audio the clip had.
// This is the second half of the scoring loop: video_to_audio produces a bare
// mp3, and the picture has to get it back. `mode` decides what happens when the
// two lengths disagree — "video" (default) keeps the cut and trims/pads the
// track, "shortest" ends at whichever runs out first.
export async function muxAudio(
  videoPath: string,
  audioPath: string,
  outPath: string,
  mode: "video" | "shortest" = "video",
): Promise<void> {
  // mode "video" pins the output to the picture's length. Without an explicit
  // -t the container runs to the LONGEST stream, so a 56s music bed silently
  // turns a 30s cut into a 56s file with frozen tail (observed in practice).
  const videoDur = mode === "video" ? await probeDuration(videoPath) : 0;
  const args = [
    "-i", videoPath,
    "-i", audioPath,
    "-map", "0:v:0",
    "-map", "1:a:0",
    "-c:v", "copy", // never re-encode the picture just to attach sound
    "-c:a", "aac",
    "-b:a", "192k",
    ...(mode === "shortest" ? ["-shortest"] : []),
    ...(mode === "video" && videoDur > 0 ? ["-t", String(videoDur)] : []),
    "-movflags", "+faststart",
    "-y", outPath,
  ];
  await run(FFMPEG, args);
}

/**
 * Cut [startSec, endSec) out of a video. The picture is re-encoded rather than
 * stream-copied: a copy can only cut on keyframes, which for a 4s generated
 * clip can miss the intended point by most of a second.
 */
export async function trimVideo(
  input: string,
  startSec: number,
  endSec: number,
  outPath: string,
): Promise<void> {
  const start = Math.max(0, startSec);
  const dur = endSec - start;
  if (!(dur > 0)) throw new Error(`trim: end (${endSec}s) must be after start (${start}s)`);
  await run(FFMPEG, [
    "-ss", String(start),
    "-i", input,
    "-t", String(dur),
    "-c:v", "libx264", "-crf", "16", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-y", outPath,
  ]);
}

// Extract a single frame at `timeSec` seconds as a PNG (accurate seek).
export async function extractFrame(
  input: string,
  timeSec: number,
  outPath: string,
): Promise<void> {
  const t = Math.max(0, timeSec);
  await run(FFMPEG, ["-ss", String(t), "-i", input, "-frames:v", "1", "-y", outPath]);
}
