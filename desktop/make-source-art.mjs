import sharp from "sharp";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Source artwork for the app icon. Kept as code rather than a binary so the
// icon can be regenerated: `node make-source-art.mjs && node make-icon.mjs source-art.png`.
//
// Deliberately warm (amber -> magenta on a dark ember ground) because Creative
// Canvas — the app this one is a sibling of — is cool navy/blue/violet. At Dock
// size hue is the only thing that separates two icons, so the shared node-graph
// motif is fine but the palette must not be.
//
// The composition is hub-and-spoke rather than Creative Canvas's spiral: every
// model in this app is reached through one API, and the icon says so.

const S = 1024;
const C = S / 2;

const HUB = 62;
const SPOKES = 7;
const R_SAT = 300;
const R_OUTER = 430;

function polar(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

const sats = Array.from({ length: SPOKES }, (_, i) => {
  const deg = (360 / SPOKES) * i + 12;
  const [x, y] = polar(R_SAT, deg);
  // Amber at the top, sweeping through orange to magenta around the ring.
  const t = i / (SPOKES - 1);
  return { x, y, deg, r: 30 - 5 * Math.abs(t - 0.5) * 2, t };
});

const mix = (t) => {
  // #fbbf24 (amber) -> #f97316 (orange) -> #e11d8f (magenta)
  const stops = [
    [251, 191, 36],
    [249, 115, 22],
    [225, 29, 143],
  ];
  const seg = t < 0.5 ? 0 : 1;
  const lt = t < 0.5 ? t * 2 : (t - 0.5) * 2;
  const [a, b] = [stops[seg], stops[seg + 1]];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * lt));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

// Spokes bow slightly so the graph reads as drawn rather than mechanical.
const edges = sats
  .map((s) => {
    const [mx, my] = polar(R_SAT * 0.55, s.deg - 9);
    return `<path d="M ${C} ${C} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${s.x.toFixed(1)} ${s.y.toFixed(1)}"
      stroke="${mix(s.t)}" stroke-width="7" fill="none" stroke-linecap="round" opacity="0.85"/>`;
  })
  .join("\n");

// A thin ring threading the satellites keeps the silhouette round at 16px,
// where individual spokes disappear.
const ring = sats
  .map((s, i) => {
    const n = sats[(i + 1) % sats.length];
    const midDeg = s.deg + 360 / SPOKES / 2;
    const [mx, my] = polar(R_SAT * 1.16, midDeg);
    return `<path d="M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${n.x.toFixed(1)} ${n.y.toFixed(1)}"
      stroke="${mix(s.t)}" stroke-width="4" fill="none" stroke-linecap="round" opacity="0.4"/>`;
  })
  .join("\n");

const nodes = sats
  .map(
    (s) =>
      `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${s.r.toFixed(1)}" fill="${mix(s.t)}"/>` +
      `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${(s.r * 0.42).toFixed(1)}" fill="#fff7ed" opacity="0.9"/>`,
  )
  .join("\n");

// Faint outer specks, echoing the sibling app's constellation feel.
const specks = [22, 68, 133, 196, 251, 304, 348]
  .map((deg, i) => {
    const [x, y] = polar(R_OUTER - (i % 3) * 26, deg);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${7 - (i % 3)}" fill="${mix((i % 7) / 6)}" opacity="0.55"/>`;
  })
  .join("\n");

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="38%" r="78%">
      <stop offset="0%" stop-color="#3a1a0b"/>
      <stop offset="55%" stop-color="#241008"/>
      <stop offset="100%" stop-color="#140805"/>
    </radialGradient>
    <radialGradient id="hubGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#fbbf24" stop-opacity="0"/>
    </radialGradient>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="14"/>
    </filter>
  </defs>

  <rect width="${S}" height="${S}" fill="url(#bg)"/>
  <circle cx="${C}" cy="${C}" r="${R_SAT + 60}" fill="url(#hubGlow)"/>

  <g filter="url(#soft)" opacity="0.55">
    ${edges}
    ${nodes}
  </g>

  ${ring}
  ${edges}
  ${specks}
  ${nodes}

  <circle cx="${C}" cy="${C}" r="${HUB}" fill="#fbbf24"/>
  <circle cx="${C}" cy="${C}" r="${HUB * 0.55}" fill="#fff7ed"/>
</svg>`;

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "source-art.png");
await sharp(Buffer.from(svg)).png().toFile(out);
console.log("source art ready at", out);
