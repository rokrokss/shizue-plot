// Writes the demo works' cover art (600x900 SVG) into covers/. Every picture is
// drawn here from shapes, so the promo images carry no third-party art.
// Usage: node docs/promo/demo/covers.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), 'covers');
mkdirSync(out, { recursive: true });

// A small seeded random, so the stars and windows land in the same places every run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const svg = (body, defs = '') =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 900" width="600" height="900"><defs>
  <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="2.2"/></filter>
  <filter id="haze" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="30"/></filter>
  ${defs}</defs>${body}</svg>`;

function stars(rand, n, { top = 0, bottom = 500, color = '#fff', max = 1.8 } = {}) {
  let s = '';
  for (let i = 0; i < n; i++) {
    const r = 0.4 + rand() * max;
    s += `<circle cx="${(rand() * 600).toFixed(1)}" cy="${(top + rand() * (bottom - top)).toFixed(1)}" r="${r.toFixed(2)}" fill="${color}" opacity="${(0.35 + rand() * 0.65).toFixed(2)}"/>`;
  }
  return s;
}

// A standing figure in a long coat, feet at (0,0), about 100 units tall.
const COAT = 'M-9 -80 Q0 -84 9 -80 L12 -66 L14 -44 L18 -14 L7 -14 L6 0 L2 0 L1 -14 L-1 -14 L-2 0 L-6 0 L-7 -14 L-18 -14 L-14 -44 L-12 -66 Z';
const figure = ({ x, y, s = 1, fill, extra = '' }) =>
  `<g transform="translate(${x} ${y}) scale(${s})" fill="${fill}"><circle cx="0" cy="-90" r="8"/><path d="${COAT}"/>${extra}</g>`;

// 1. The Lighthouse at Gull's End — night sea, moon, a keeper with a lantern on the cliff.
function lighthouse() {
  const rand = rng(11);
  let waves = '';
  for (let i = 0; i < 26; i++) {
    const y = 640 + i * 10 + rand() * 6;
    const x = rand() * 600;
    const w = 30 + rand() * 120;
    waves += `<rect x="${x.toFixed(0)}" y="${y.toFixed(0)}" width="${w.toFixed(0)}" height="2" rx="1" fill="#9fe9e0" opacity="${(0.08 + rand() * 0.18).toFixed(2)}"/>`;
  }
  let glints = '';
  for (let i = 0; i < 16; i++) {
    const y = 652 + i * 14;
    const w = 90 - i * 3 + rand() * 30;
    glints += `<rect x="${(175 - w / 2 + (rand() - 0.5) * 30).toFixed(0)}" y="${y}" width="${w.toFixed(0)}" height="3" rx="1.5" fill="#f4f1d8" opacity="${(0.55 - i * 0.028).toFixed(2)}"/>`;
  }
  return svg(
    `<rect width="600" height="900" fill="url(#sky)"/>
    ${stars(rand, 140, { bottom: 560 })}
    <circle cx="175" cy="230" r="120" fill="#e9f7c8" opacity="0.25" filter="url(#haze)"/>
    <circle cx="175" cy="230" r="62" fill="#f4f1d8"/>
    <circle cx="198" cy="214" r="12" fill="#e3dfbf" opacity="0.6"/><circle cx="158" cy="252" r="8" fill="#e3dfbf" opacity="0.5"/>
    <polygon points="438,402 -60,250 -60,470" fill="url(#beam)" opacity="0.55"/>
    <rect y="636" width="600" height="264" fill="url(#sea)"/>
    ${glints}${waves}
    <path d="M330 900 L330 640 Q360 600 380 560 Q400 520 452 512 Q520 506 560 540 L600 560 L600 900 Z" fill="#05121d"/>
    <path d="M330 640 Q300 660 250 700 L250 900 L330 900 Z" fill="#05121d"/>
    <g>
      <polygon points="420,512 456,512 450,416 426,416" fill="#e8ecef"/>
      <polygon points="421.6,488 454.4,488 453.3,470 422.7,470" fill="#c94f4f"/>
      <polygon points="424,446 452,446 451,432 425,432" fill="#c94f4f"/>
      <rect x="420" y="408" width="36" height="8" fill="#0d2230"/>
      <rect x="426" y="384" width="24" height="24" fill="#fff3b0"/>
      <circle cx="438" cy="396" r="34" fill="#fff3b0" opacity="0.55" filter="url(#glow)"/>
      <polygon points="422,384 454,384 438,366" fill="#0d2230"/>
      <rect x="436" y="358" width="4" height="9" fill="#0d2230"/>
    </g>
    ${figure({ x: 372, y: 588, s: 0.62, fill: '#05121d', extra: '<line x1="16" y1="-50" x2="17" y2="-36" stroke="#05121d" stroke-width="2"/><rect x="11" y="-38" width="12" height="15" rx="2" fill="#ffd27a"/>' })}
    <circle cx="383" cy="569" r="16" fill="#ffd27a" opacity="0.6" filter="url(#glow)"/>
    <path d="M60 330 l10 -6 l10 6 M100 300 l8 -5 l8 5 M520 250 l7 -4 l7 4" stroke="#cfe8e4" stroke-width="2.4" fill="none" stroke-linecap="round" opacity="0.7"/>`,
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#071528"/><stop offset="0.55" stop-color="#123a55"/><stop offset="0.72" stop-color="#2c7279"/></linearGradient>
    <linearGradient id="sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#174a57"/><stop offset="1" stop-color="#061722"/></linearGradient>
    <linearGradient id="beam" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#fff3b0" stop-opacity="0.9"/><stop offset="1" stop-color="#fff3b0" stop-opacity="0"/></linearGradient>`,
  );
}

// 2. Neon Rain — a detective under an umbrella in a city of signs.
function neon() {
  const rand = rng(23);
  const buildings = [];
  let x = -10;
  while (x < 610) {
    const w = 60 + rand() * 70;
    const h = 380 + rand() * 360;
    buildings.push({ x, w, h });
    x += w - 4;
  }
  let city = '';
  for (const b of buildings) {
    const top = 900 - h(b);
    city += `<rect x="${b.x.toFixed(0)}" y="${top.toFixed(0)}" width="${b.w.toFixed(0)}" height="${b.h.toFixed(0)}" fill="#120a24"/>`;
    for (let wy = top + 18; wy < 760; wy += 22) {
      for (let wx = b.x + 10; wx < b.x + b.w - 14; wx += 16) {
        if (rand() < 0.38) {
          const c = rand() < 0.75 ? '#ffd9a0' : '#7ff0ff';
          city += `<rect x="${wx.toFixed(0)}" y="${wy.toFixed(0)}" width="7" height="10" fill="${c}" opacity="${(0.25 + rand() * 0.6).toFixed(2)}"/>`;
        }
      }
    }
  }
  function h(b) { return b.h; }
  const sign = (sx, sy, w, hgt, color) =>
    `<rect x="${sx}" y="${sy}" width="${w}" height="${hgt}" rx="6" fill="none" stroke="${color}" stroke-width="10" opacity="0.5" filter="url(#glow)"/><rect x="${sx}" y="${sy}" width="${w}" height="${hgt}" rx="6" fill="#1a0d2e" stroke="${color}" stroke-width="3.5"/>`;
  const bars = (sx, sy, n, color) => {
    let s = '';
    for (let i = 0; i < n; i++) s += `<rect x="${sx + 9}" y="${sy + 12 + i * 22}" width="18" height="12" rx="3" fill="${color}"/>`;
    return s;
  };
  let rain = '';
  for (let i = 0; i < 220; i++) {
    const rx = rand() * 640 - 20;
    const ry = rand() * 900;
    const len = 14 + rand() * 26;
    rain += `<line x1="${rx.toFixed(0)}" y1="${ry.toFixed(0)}" x2="${(rx - len * 0.22).toFixed(0)}" y2="${(ry + len).toFixed(0)}" stroke="#bfe9ff" stroke-width="1.2" opacity="${(0.15 + rand() * 0.35).toFixed(2)}"/>`;
  }
  return svg(
    `<rect width="600" height="900" fill="url(#nsky)"/>
    <circle cx="300" cy="300" r="220" fill="#ff3fa4" opacity="0.18" filter="url(#haze)"/>
    ${city}
    ${sign(60, 250, 36, 160, '#ff4fb0')}${bars(60, 250, 7, '#ff8fd0')}
    ${sign(488, 300, 36, 138, '#4ff4ff')}${bars(488, 300, 6, '#a8fbff')}
    ${sign(372, 520, 110, 44, '#ffcf4f')}<rect x="388" y="536" width="78" height="12" rx="6" fill="#ffe7a3"/>
    <rect y="760" width="600" height="140" fill="url(#street)"/>
    <rect x="60" y="770" width="36" height="120" fill="#ff4fb0" opacity="0.22" filter="url(#glow)"/>
    <rect x="488" y="770" width="36" height="110" fill="#4ff4ff" opacity="0.22" filter="url(#glow)"/>
    <ellipse cx="300" cy="842" rx="150" ry="12" fill="#ff74c4" opacity="0.25" filter="url(#soft)"/>
    ${figure({ x: 300, y: 840, s: 1.55, fill: '#07040f', extra: '<ellipse cx="0" cy="-97" rx="14" ry="3"/><rect x="-8" y="-108" width="16" height="11" rx="3"/><path d="M-38 -104 Q0 -150 38 -104 Q28 -110 19 -104 Q10 -112 0 -104 Q-10 -112 -19 -104 Q-28 -110 -38 -104 Z"/><line x1="0" y1="-130" x2="2" y2="-62" stroke="#07040f" stroke-width="2.4"/>' })}
    <path d="M241 680 Q300 608 359 680" fill="none" stroke="#ff74c4" stroke-width="2.5" opacity="0.8"/>
    ${rain}`,
    `<linearGradient id="nsky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b0620"/><stop offset="0.6" stop-color="#3a1452"/><stop offset="1" stop-color="#6b1d5e"/></linearGradient>
    <linearGradient id="street" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a0f3a"/><stop offset="1" stop-color="#0b0618"/></linearGradient>`,
  );
}

// 3. The Fox Shrine — dusk, a torii gate, fireflies and a fox on the steps.
function shrine() {
  const rand = rng(37);
  let flies = '';
  for (let i = 0; i < 46; i++) {
    const fx = rand() * 600;
    const fy = 380 + rand() * 470;
    const r = 1.4 + rand() * 2.2;
    flies += `<circle cx="${fx.toFixed(0)}" cy="${fy.toFixed(0)}" r="${(r * 4).toFixed(1)}" fill="#ffe58a" opacity="0.25" filter="url(#soft)"/><circle cx="${fx.toFixed(0)}" cy="${fy.toFixed(0)}" r="${r.toFixed(1)}" fill="#fff6c4"/>`;
  }
  const cedar = (cx, base, w, hgt, fill) => {
    let s = `<rect x="${cx - 4}" y="${base - 30}" width="8" height="30" fill="${fill}"/>`;
    for (let i = 0; i < 5; i++) {
      const y = base - 24 - i * (hgt / 5);
      const half = w * (1 - i * 0.16);
      s += `<polygon points="${cx - half},${y} ${cx + half},${y} ${cx},${y - hgt / 3.2}" fill="${fill}"/>`;
    }
    return s;
  };
  let steps = '';
  for (let i = 0; i < 9; i++) {
    const y = 700 + i * 24;
    const half = 70 + i * 26;
    steps += `<rect x="${300 - half}" y="${y}" width="${half * 2}" height="24" fill="${i % 2 ? '#2a1830' : '#331d39'}"/>`;
  }
  return svg(
    `<rect width="600" height="900" fill="url(#dusk)"/>
    ${stars(rand, 50, { bottom: 260, max: 1.2 })}
    <circle cx="420" cy="430" r="70" fill="#ffd3a1" opacity="0.9"/>
    <circle cx="420" cy="430" r="140" fill="#ffb27a" opacity="0.35" filter="url(#haze)"/>
    <path d="M0 560 Q120 470 240 520 Q360 450 470 500 Q540 470 600 490 L600 900 L0 900 Z" fill="#7a3a63" opacity="0.75"/>
    <path d="M0 620 Q150 560 300 600 Q450 550 600 590 L600 900 L0 900 Z" fill="#4e2347"/>
    ${cedar(60, 760, 70, 420, '#2b1430')}${cedar(540, 770, 76, 440, '#2b1430')}${cedar(130, 720, 46, 260, '#38183a')}${cedar(470, 724, 50, 280, '#38183a')}
    ${steps}
    <g fill="#e2492f">
      <rect x="176" y="420" width="22" height="290"/><rect x="402" y="420" width="22" height="290"/>
      <rect x="160" y="468" width="280" height="18"/>
      <path d="M126 404 Q300 418 474 404 L480 384 Q300 400 120 384 Z"/>
    </g>
    <path d="M118 384 Q300 400 482 384 L484 374 Q300 388 116 374 Z" fill="#2b1430"/>
    <rect x="285" y="430" width="30" height="38" fill="#2b1430"/>
    <rect x="176" y="696" width="22" height="14" fill="#2b1430"/><rect x="402" y="696" width="22" height="14" fill="#2b1430"/>
    <g transform="translate(300 726) scale(1.7)" fill="#1c0d21">
      <ellipse cx="0" cy="-28" rx="15" ry="25"/>
      <ellipse cx="-6" cy="-58" rx="11" ry="10"/>
      <polygon points="-15,-60 -28,-55 -14,-51"/>
      <polygon points="-13,-64 -12,-80 -5,-66"/><polygon points="-3,-66 1,-81 4,-63"/>
      <path d="M10 -6 C48 -2 56 -44 34 -66 C40 -42 34 -20 8 -22 Z"/>
      <rect x="-11" y="-14" width="6" height="14"/><rect x="-2" y="-14" width="6" height="14"/>
    </g>
    <path d="M352 650 C360 640 355 628 362 618" stroke="#9ff6ff" stroke-width="3" fill="none" opacity="0.85" stroke-linecap="round"/>
    <circle cx="362" cy="616" r="7" fill="#9ff6ff" opacity="0.9"/><circle cx="362" cy="616" r="18" fill="#9ff6ff" opacity="0.4" filter="url(#soft)"/>
    <circle cx="238" cy="604" r="6" fill="#9ff6ff" opacity="0.9"/><circle cx="238" cy="604" r="16" fill="#9ff6ff" opacity="0.4" filter="url(#soft)"/>
    ${flies}`,
    `<linearGradient id="dusk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d1236"/><stop offset="0.38" stop-color="#5a2a5e"/><stop offset="0.6" stop-color="#c2546b"/><stop offset="0.75" stop-color="#f4a25b"/></linearGradient>`,
  );
}

// 4. Orbit Café — a ringed planet outside the round window of a station café.
function orbit() {
  const rand = rng(41);
  return svg(
    `<rect width="600" height="900" fill="url(#space)"/>
    ${stars(rand, 220, { bottom: 900, max: 1.5 })}
    <circle cx="300" cy="420" r="230" fill="#0a0716"/>
    <g clip-path="url(#port)">
      <rect x="70" y="190" width="460" height="460" fill="#05040d"/>
      ${stars(rand, 90, { top: 190, bottom: 650, max: 1.3 })}
      <circle cx="380" cy="520" r="150" fill="url(#planet)"/>
      <path d="M380 520 m-150 0 a150 150 0 0 0 300 0" fill="#000" opacity="0.18"/>
      <ellipse cx="380" cy="520" rx="250" ry="46" fill="none" stroke="#ffd6a5" stroke-width="10" opacity="0.65" transform="rotate(-14 380 520)"/>
      <ellipse cx="380" cy="520" rx="226" ry="38" fill="none" stroke="#f7b98b" stroke-width="5" opacity="0.5" transform="rotate(-14 380 520)"/>
      <circle cx="170" cy="300" r="26" fill="#cfe8ff"/><circle cx="178" cy="294" r="26" fill="#05040d" opacity="0.65"/>
    </g>
    <circle cx="300" cy="420" r="230" fill="none" stroke="#3b3355" stroke-width="22"/>
    <circle cx="300" cy="420" r="219" fill="none" stroke="#6a5f8f" stroke-width="2"/>
    <rect y="700" width="600" height="200" fill="#1a1426"/>
    <rect y="700" width="600" height="10" fill="#3b2f4a"/>
    <rect y="710" width="600" height="190" fill="url(#counter)"/>
    <circle cx="300" cy="520" r="200" fill="#ffb26b" opacity="0.08" filter="url(#haze)"/>
    ${figure({ x: 210, y: 700, s: 1.35, fill: '#0c0918', extra: '<rect x="-5" y="-100" width="10" height="4" fill="#4ff4e0"/><rect x="11" y="-60" width="14" height="14" rx="3"/>' })}
    <circle cx="203" cy="565" r="3" fill="#4ff4e0"/>
    <path d="M232 612 q6 -10 0 -18 q-6 -8 0 -16 M242 612 q6 -10 0 -18" stroke="#e8e0ff" stroke-width="2" fill="none" opacity="0.5" stroke-linecap="round"/>
    <rect x="360" y="664" width="26" height="36" rx="4" fill="#f6c28b"/><rect x="386" y="672" width="8" height="16" rx="4" fill="none" stroke="#f6c28b" stroke-width="4"/>
    <rect x="420" y="676" width="80" height="24" rx="4" fill="#3b2f4a"/><circle cx="440" cy="688" r="5" fill="#4ff4e0"/><circle cx="460" cy="688" r="5" fill="#ff8fb8"/>
    <rect x="0" y="40" width="600" height="6" fill="#2a2240"/><circle cx="120" cy="43" r="9" fill="#ffd27a" opacity="0.9"/><circle cx="300" cy="43" r="9" fill="#ffd27a" opacity="0.9"/><circle cx="480" cy="43" r="9" fill="#ffd27a" opacity="0.9"/>
    <circle cx="120" cy="50" r="30" fill="#ffd27a" opacity="0.25" filter="url(#glow)"/><circle cx="300" cy="50" r="30" fill="#ffd27a" opacity="0.25" filter="url(#glow)"/><circle cx="480" cy="50" r="30" fill="#ffd27a" opacity="0.25" filter="url(#glow)"/>`,
    `<linearGradient id="space" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#150f2c"/><stop offset="1" stop-color="#2a1a3f"/></linearGradient>
    <radialGradient id="planet" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#ffcf9e"/><stop offset="0.5" stop-color="#e0786a"/><stop offset="1" stop-color="#5a2a5e"/></radialGradient>
    <linearGradient id="counter" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2a2038"/><stop offset="1" stop-color="#120d1c"/></linearGradient>
    <clipPath id="port"><circle cx="300" cy="420" r="220"/></clipPath>`,
  );
}

// 5. Ashfall Academy — two rival mages on a bridge below a burning sky.
function academy() {
  const rand = rng(53);
  let embers = '';
  for (let i = 0; i < 70; i++) {
    const ex = rand() * 600;
    const ey = rand() * 760;
    const r = 1 + rand() * 2.6;
    embers += `<circle cx="${ex.toFixed(0)}" cy="${ey.toFixed(0)}" r="${r.toFixed(1)}" fill="#ffb15c" opacity="${(0.4 + rand() * 0.6).toFixed(2)}"/>`;
  }
  const spire = (x, w, top, fill) =>
    `<rect x="${x}" y="${top}" width="${w}" height="${900 - top}" fill="${fill}"/><polygon points="${x - 6},${top} ${x + w + 6},${top} ${x + w / 2},${top - w * 1.8}" fill="${fill}"/>` +
    `<rect x="${x + w / 2 - 4}" y="${top + 30}" width="8" height="14" rx="4" fill="#ffcf7a" opacity="0.85"/>`;
  return svg(
    `<rect width="600" height="900" fill="url(#ash)"/>
    <circle cx="300" cy="330" r="110" fill="#ffd08a" opacity="0.9"/>
    <circle cx="300" cy="330" r="210" fill="#ff7a3c" opacity="0.4" filter="url(#haze)"/>
    ${spire(70, 46, 420, '#4a1420')}${spire(150, 34, 360, '#4a1420')}${spire(420, 40, 380, '#4a1420')}${spire(500, 52, 440, '#4a1420')}
    ${spire(245, 110, 300, '#2b0a14')}
    <rect x="200" y="470" width="200" height="430" fill="#2b0a14"/>
    <rect x="292" y="520" width="16" height="26" rx="8" fill="#ffcf7a" opacity="0.85"/>
    <path d="M0 690 Q300 640 600 690 L600 712 Q300 662 0 712 Z" fill="#17060c"/>
    <rect y="706" width="600" height="194" fill="#17060c"/>
    <ellipse cx="300" cy="664" rx="86" ry="18" fill="none" stroke="#7af2ff" stroke-width="3" opacity="0.9"/>
    <ellipse cx="300" cy="664" rx="64" ry="12" fill="none" stroke="#7af2ff" stroke-width="2" opacity="0.7"/>
    <ellipse cx="300" cy="664" rx="96" ry="24" fill="#7af2ff" opacity="0.25" filter="url(#glow)"/>
    <path d="M300 664 L300 560" stroke="#7af2ff" stroke-width="3" opacity="0.5" filter="url(#soft)"/>
    ${figure({ x: 196, y: 668, s: 1.05, fill: '#0d0307', extra: '<polygon points="-10,-94 10,-94 0,-122"/><line x1="20" y1="-110" x2="24" y2="0" stroke="#0d0307" stroke-width="3"/><circle cx="20" cy="-112" r="6" fill="#ff8a4c"/>' })}
    <circle cx="217" cy="551" r="16" fill="#ff8a4c" opacity="0.6" filter="url(#glow)"/>
    ${figure({ x: 404, y: 668, s: 1.05, fill: '#0d0307', extra: '<path d="M-10 -96 Q0 -112 10 -96 Z"/><line x1="-20" y1="-110" x2="-24" y2="0" stroke="#0d0307" stroke-width="3"/><circle cx="-20" cy="-112" r="6" fill="#7af2ff"/>' })}
    <circle cx="383" cy="551" r="16" fill="#7af2ff" opacity="0.6" filter="url(#glow)"/>
    ${embers}`,
    `<linearGradient id="ash" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1e0610"/><stop offset="0.45" stop-color="#7a1a24"/><stop offset="0.75" stop-color="#e2582f"/></linearGradient>`,
  );
}

const covers = { lighthouse, neon, shrine, orbit, academy };
for (const [name, draw] of Object.entries(covers)) {
  writeFileSync(join(out, `${name}.svg`), draw());
  console.log(`wrote covers/${name}.svg`);
}
