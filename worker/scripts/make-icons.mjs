// Re-make the app icons: npm i --no-save @resvg/resvg-js@2.6.2, then
// node scripts/make-icons.mjs <preview folder> app/icons.js   (uses Windows Malgun Gothic for 하)
// Haneul's new icon: 하 (from 하늘, "sky") on a dusk sky. Renders PNGs with resvg + Malgun Gothic.
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync } from "node:fs";

const FONT = "C:/Windows/Fonts/malgunbd.ttf";
const stars = [[0.22, 0.17, 0.010], [0.79, 0.13, 0.013], [0.88, 0.36, 0.008], [0.14, 0.40, 0.007], [0.68, 0.27, 0.006], [0.33, 0.09, 0.006]];

function icon(size, { glyph = 0.5, round = false } = {}) {
  const s = size;
  const st = stars.map(([x, y, r]) => `<circle cx="${x * s}" cy="${y * s}" r="${Math.max(1, r * s)}" fill="#fff" opacity="0.9"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#161a48"/><stop offset="0.45" stop-color="#3f3487"/>
      <stop offset="0.72" stop-color="#a5589b"/><stop offset="1" stop-color="#f4977c"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.56" r="0.42">
      <stop offset="0" stop-color="#ffe7d4" stop-opacity="0.32"/><stop offset="1" stop-color="#ffe7d4" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <clipPath id="r"><rect width="${s}" height="${s}" rx="${round ? s * 0.225 : 0}"/></clipPath>
  <g clip-path="url(#r)">
  <rect width="${s}" height="${s}" fill="url(#sky)"/>
  ${st}
  <rect width="${s}" height="${s}" fill="url(#glow)"/>
  <text x="${s / 2}" y="${s * 0.5}" text-anchor="middle" dominant-baseline="central" font-family="Malgun Gothic" font-weight="700"
    font-size="${s * glyph}" fill="#fff6e8">하</text>
  </g>
</svg>`;
}

// monochrome badge for Android notifications: white 하 on transparent
const badge = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}">
  <text x="${s / 2}" y="${s * 0.5}" text-anchor="middle" dominant-baseline="central" font-family="Malgun Gothic" font-weight="700" font-size="${s * 0.78}" fill="#ffffff">하</text>
</svg>`;

const render = (svg, w) => new Resvg(svg, { fitTo: { mode: "width", value: w }, font: { fontFiles: [FONT], loadSystemFonts: false, defaultFontFamily: "Malgun Gothic" } }).render().asPng();

// rounded corners (transparent) for places that show the image as-is (Windows window/taskbar, tabs);
// a full square "maskable" version for Android, which applies its own shape
const i512 = render(icon(512, { glyph: 0.5, round: true }), 512);
const i192 = render(icon(192, { glyph: 0.5, round: true }), 192);
const m512 = render(icon(512, { glyph: 0.46 }), 512); // glyph inside the maskable safe zone
const b96 = render(badge(96), 96);
const out = process.argv[2];
writeFileSync(`${out}/preview512.png`, i512);
writeFileSync(`${out}/preview_badge.png`, b96);
writeFileSync(process.argv[3], `// Generated app icons: 하 (from 하늘, "sky") on a dusk sky. PNG, base64. (iconkit/make.mjs)
export const ICON_192 = "${Buffer.from(i192).toString("base64")}";
export const ICON_512 = "${Buffer.from(i512).toString("base64")}";
export const ICON_MASKABLE = "${Buffer.from(m512).toString("base64")}";
// Notification badge: white 하 on transparent (Android masks it to one colour).
export const BADGE_96 = "${Buffer.from(b96).toString("base64")}";
`);
console.log("sizes", i512.length, i192.length, b96.length);
