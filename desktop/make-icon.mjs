import sharp from "sharp";
import { execSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Usage: node make-icon.mjs <source-image>
const here = path.dirname(fileURLToPath(import.meta.url));
const src = process.argv[2];
if (!src) {
  console.error("usage: node make-icon.mjs <source-image>");
  process.exit(1);
}

const outDir = path.join(here, "buildResources");
const iconset = path.join(outDir, "icon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

const CANVAS = 1024; // full icon canvas
const CONTENT = 824; // macOS icon grid: rounded square within the canvas
const RADIUS = Math.round(CONTENT * 0.2237); // Apple squircle corner radius
const pad = (CANVAS - CONTENT) / 2;

// 1) Trim the flat background so we keep just the artwork's rounded tile.
const trimmed = await sharp(src).trim({ threshold: 30 }).toBuffer();

// 2) Fit into the content square.
const art = await sharp(trimmed)
  .resize(CONTENT, CONTENT, { fit: "cover" })
  .ensureAlpha()
  .toBuffer();

// 3) Clip to the standard rounded-rectangle (transparent corners).
const mask = Buffer.from(
  `<svg width="${CONTENT}" height="${CONTENT}"><rect width="${CONTENT}" height="${CONTENT}" rx="${RADIUS}" ry="${RADIUS}" fill="#fff"/></svg>`,
);
const rounded = await sharp(art)
  .composite([{ input: mask, blend: "dest-in" }])
  .png()
  .toBuffer();

// 4) Center on the transparent full canvas.
const master = await sharp({
  create: {
    width: CANVAS,
    height: CANVAS,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([{ input: rounded, left: pad, top: pad }])
  .png()
  .toBuffer();

await sharp(master).toFile(path.join(outDir, "icon.png"));

// 5) Emit the .iconset at all required sizes, then build .icns.
const sizes = [
  [16, "16x16"],
  [32, "16x16@2x"],
  [32, "32x32"],
  [64, "32x32@2x"],
  [128, "128x128"],
  [256, "128x128@2x"],
  [256, "256x256"],
  [512, "256x256@2x"],
  [512, "512x512"],
  [1024, "512x512@2x"],
];
for (const [px, name] of sizes) {
  await sharp(master)
    .resize(px, px)
    .png()
    .toFile(path.join(iconset, `icon_${name}.png`));
}

execSync(`iconutil -c icns "${iconset}" -o "${path.join(outDir, "icon.icns")}"`);
console.log("icon.icns ready at", path.join(outDir, "icon.icns"));
