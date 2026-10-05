import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";

/**
 * Where package managers put the binary. A GUI app does not see the PATH a
 * shell would (macOS launches it with a bare one; on Windows a PATH entry added
 * by an install made after login may not have reached Explorer yet), so the
 * usual locations are tried before falling back to PATH.
 */
function candidates(name: string): string[] {
  if (!IS_WINDOWS) return [`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`];
  const exe = `${name}.exe`;
  const env = process.env;
  return [
    // winget install Gyan.FFmpeg (the route the README gives)
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe),
    // scoop / chocolatey
    env.USERPROFILE && path.join(env.USERPROFILE, "scoop", "shims", exe),
    env.ProgramData && path.join(env.ProgramData, "chocolatey", "bin", exe),
    // unzipped by hand, the layout ffmpeg's own Windows builds ship in
    env.ProgramFiles && path.join(env.ProgramFiles, "ffmpeg", "bin", exe),
    path.join("C:\\", "ffmpeg", "bin", exe),
  ].filter((c): c is string => !!c);
}

// Resolve a binary: explicit env override, then common install locations, then PATH.
function findBin(name: string, envVar: string): string {
  const env = process.env[envVar];
  if (env) return env;
  for (const c of candidates(name)) if (existsSync(c)) return c;
  return name; // fall back to PATH (spawn finds name.exe there on Windows)
}

const FFMPEG = findBin("ffmpeg", "PIKA_CANVAS_FFMPEG");
const FFPROBE = findBin("ffprobe", "PIKA_CANVAS_FFPROBE");

const INSTALL_HINT = IS_WINDOWS
  ? "PowerShell で `winget install Gyan.FFmpeg` を実行してからアプリを再起動するか、" +
    "設定ファイルの PIKA_CANVAS_FFMPEG / PIKA_CANVAS_FFPROBE に ffmpeg.exe / ffprobe.exe の場所を書いてください"
  : "`brew install ffmpeg` でインストールするか、PIKA_CANVAS_FFMPEG / PIKA_CANVAS_FFPROBE で場所を指定してください";

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    // windowsHide: the server runs under a GUI app, and without it every
    // ffmpeg call flashes a console window on Windows.
    const p = spawn(bin, args, { windowsHide: true });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", (e) =>
      reject(new Error(`${bin} の起動に失敗しました（${INSTALL_HINT}）: ${e.message}`)),
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

/**
 * Re-encode a clip so it fits inside `maxBytes`, for models that only *analyse*
 * the picture (scoring, transcription) and never return it. The audio is copied
 * untouched wherever the container allows it — a transcript must not be read off
 * a re-compressed track — and only the video is squeezed: capped at 720p and
 * given whatever bitrate the remaining budget allows.
 *
 * Callers must check the result: a long enough clip cannot be made to fit at any
 * sane bitrate, and silently shipping a smear would be worse than failing.
 */
export async function shrinkForUpload(
  input: string,
  outPath: string,
  maxBytes: number,
): Promise<void> {
  const duration = await probeDuration(input);
  if (!duration) throw new Error(`尺を測れませんでした: ${input}`);

  // 8% headroom for container overhead and rate-control overshoot.
  const budgetBits = maxBytes * 8 * 0.92;
  const audioBits = 160_000; // whatever the copied track costs, generously
  // Spend the budget, but not pointlessly: 8 Mbps is already generous for a 720p
  // clip nobody will watch, and a smaller proxy uploads faster. A long clip gets
  // whatever the budget allows instead, which is the whole reason for the min().
  const videoBps = Math.max(
    200_000,
    Math.min(8_000_000, Math.floor(budgetBits / duration - audioBits)),
  );

  // Resolve the target height here rather than with an ffmpeg expression:
  // min(720\,ih) has to survive both a JS string and ffmpeg's own comma
  // splitting, and when the escaping slips the filtergraph breaks at run time.
  const { h } = await probeSize(input);
  const targetH = Math.max(2, (Math.min(720, h || 720) >> 1) << 1); // even, never upscaled

  const args = [
    "-y", "-i", input,
    "-vf", `scale=-2:${targetH}`,
    "-c:v", "libx264", "-preset", "veryfast",
    "-b:v", String(videoBps),
    "-maxrate", String(Math.floor(videoBps * 1.25)),
    "-bufsize", String(videoBps * 2),
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    outPath,
  ];
  try {
    await run(FFMPEG, args);
  } catch {
    // Some sources carry audio the mp4 container will not take verbatim
    // (pcm, opus in an odd layout). Re-encode it rather than lose the clip.
    const reAudio = args.slice();
    reAudio[reAudio.indexOf("copy")] = "aac";
    reAudio.splice(reAudio.indexOf("-movflags"), 0, "-b:a", "160k");
    await run(FFMPEG, reAudio);
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
