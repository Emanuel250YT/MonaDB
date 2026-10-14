/**
 * Line art for the landing page: a "data city" skyline (server racks, a
 * database tower, a vault, an antenna node), the sun, clouds, a paper plane
 * and balloons that carry a padlock.  Pure SVG strings, coloured by CSS
 * (style.css: .skyline, .art-*), so nothing here depends on the theme.
 */

const n = (value: number) => +value.toFixed(1);

/** One path with a small rectangle per window */
function windows(x: number, y: number, cols: number, rows: number, w: number, h: number, gx: number, gy: number): string {
  let d = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) d += `M${n(x + c * (w + gx))} ${n(y + r * (h + gy))}h${w}v${h}h${-w}Z`;
  }
  return d ? `<path d="${d}"/>` : '';
}

/** A grid of windows that fills a façade with `margin` on every side */
function facade(x: number, y: number, w: number, h: number, cols: number, ww = 6, wh = 9, margin = 8): string {
  const gx = cols > 1 ? (w - 2 * margin - cols * ww) / (cols - 1) : 0;
  const rows = Math.max(0, Math.floor((h - 2 * margin + 6) / (wh + 6)));
  return windows(x + margin, y + margin, cols, rows, ww, wh, gx, 6);
}

const rect = (x: number, y: number, w: number, h: number, extra = '') => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${extra}/>`;

type Roof = 'flat' | 'step' | 'spire' | 'antenna' | 'slant' | 'crown';

function tower(x: number, ground: number, w: number, h: number, cols: number, roof: Roof = 'flat'): string {
  const top = ground - h;
  let out = '';
  if (roof === 'step') out += rect(x + w * 0.2, top - 14, w * 0.6, 14) + rect(x + w * 0.38, top - 24, w * 0.24, 10);
  if (roof === 'spire') out += `<path d="M${n(x + w * 0.15)} ${top}L${n(x + w / 2)} ${top - h * 0.28}L${n(x + w * 0.85)} ${top}Z"/>`;
  if (roof === 'antenna') out += `<path class="open" d="M${n(x + w / 2)} ${top}V${top - 34}M${n(x + w / 2 - 6)} ${top - 18}h12"/>`;
  if (roof === 'slant') out += `<path d="M${x} ${top}L${x + w} ${top - w * 0.45}V${top}Z"/>`;
  if (roof === 'crown') out += `<path d="M${x} ${top}V${top - 10}l${n(w / 6)} 6l${n(w / 6)} -10l${n(w / 6)} 10l${n(w / 6)} -10l${n(w / 6)} 10l${n(w / 6)} -6V${top}Z"/>`;
  out += rect(x, top, w, h) + facade(x, top, w, h, cols);
  return out;
}

/** Server-rack tower: units with vents and status LEDs */
function rack(x: number, ground: number, w: number, h: number, unit = 15): string {
  const top = ground - h;
  let units = '';
  let leds = '';
  for (let y = top + 8; y + unit <= ground - 6; y += unit) {
    units += `M${x + 6} ${y}h${w - 12}v${unit - 4}h${-(w - 12)}Z`;
    units += `M${x + 11} ${n(y + unit / 2 - 2)}h${n(w * 0.4)}`;
    leds += `<circle cx="${x + w - 14}" cy="${n(y + unit / 2 - 2)}" r="1.6"/><circle cx="${x + w - 20}" cy="${n(y + unit / 2 - 2)}" r="1.6"/>`;
  }
  return `${rect(x, top, w, h)}${rect(x + w * 0.3, top - 8, w * 0.4, 8)}<path d="${units}"/>${leds}`;
}

/** Database-cylinder tower: the classic DB icon at city scale */
function cylinder(x: number, ground: number, w: number, h: number, bands = 3): string {
  const rx = w / 2;
  const ry = Math.max(6, w * 0.13);
  const cx = x + rx;
  const top = ground - h + ry;
  let d = `M${x} ${top}V${ground - ry}A${rx} ${ry} 0 0 0 ${x + w} ${ground - ry}V${top}`;
  let lines = '';
  for (let i = 1; i <= bands; i++) {
    const y = n(top + ((ground - ry - top) * i) / (bands + 1));
    lines += `M${x} ${y}A${rx} ${ry} 0 0 0 ${x + w} ${y}`;
  }
  d += 'Z';
  return `<path d="${d}"/><ellipse cx="${n(cx)}" cy="${n(top)}" rx="${n(rx)}" ry="${n(ry)}"/><path class="open" d="${lines}"/>${windows(x + w * 0.3, top + ry + 10, 3, 1, 5, 7, w * 0.1, 0)}`;
}

/** Classical vault: steps, columns, pediment and a round safe door */
function vault(x: number, ground: number, w: number, h: number): string {
  const top = ground - h;
  const pediment = h * 0.26;
  const body = top + pediment + 10;
  let columns = '';
  const count = 6;
  for (let i = 0; i < count; i++) {
    const cx = x + 14 + (i * (w - 28)) / (count - 1);
    if (Math.abs(cx - (x + w / 2)) < w * 0.16) continue;
    columns += `M${n(cx - 4)} ${body + 6}V${ground - 10}M${n(cx + 4)} ${body + 6}V${ground - 10}`;
  }
  const r = Math.min(w * 0.16, (ground - body) * 0.32);
  const cx = x + w / 2;
  const cy = ground - 12 - r;
  let spokes = '';
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    spokes += `M${n(cx + Math.cos(a) * r * 0.35)} ${n(cy + Math.sin(a) * r * 0.35)}L${n(cx + Math.cos(a) * r * 0.82)} ${n(cy + Math.sin(a) * r * 0.82)}`;
  }
  return (
    rect(x - 8, ground - 10, w + 16, 10) +
    rect(x - 4, ground - 16, w + 8, 6) +
    rect(x, body, w, ground - 16 - body) +
    rect(x - 4, body - 10, w + 8, 10) +
    `<path d="M${x - 6} ${body - 10}L${n(x + w / 2)} ${top}L${x + w + 6} ${body - 10}Z"/>` +
    `<circle cx="${n(x + w / 2)}" cy="${n(top + pediment * 0.62)}" r="5"/>` +
    `<path class="open" d="${columns}"/>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}"/><circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 0.3)}"/><path class="open" d="${spokes}"/>`
  );
}

/** Antenna node (TV-tower silhouette) with signal arcs */
function antenna(cx: number, ground: number, h: number): string {
  const top = ground - h;
  const sphereY = top + h * 0.3;
  return (
    `<path d="M${cx - 16} ${ground}L${cx - 5} ${n(sphereY + 18)}H${cx + 5}L${cx + 16} ${ground}Z"/>` +
    `<path class="open" d="M${cx - 12} ${n(ground - h * 0.25)}h24M${cx - 9} ${n(ground - h * 0.45)}h18"/>` +
    rect(cx - 14, sphereY + 12, 28, 6) +
    `<circle cx="${cx}" cy="${n(sphereY)}" r="13"/>` +
    `<path class="open" d="M${cx - 13} ${n(sphereY)}h26M${cx} ${n(sphereY - 13)}V${top}M${cx - 3} ${top + 10}h6"/>` +
    `<path class="open art-signal" d="M${cx + 20} ${n(sphereY - 10)}a14 14 0 0 1 0 20M${cx + 27} ${n(sphereY - 16)}a22 22 0 0 1 0 32M${cx - 20} ${n(sphereY - 10)}a14 14 0 0 0 0 20M${cx - 27} ${n(sphereY - 16)}a22 22 0 0 0 0 32"/>`
  );
}

/** Domed data hall */
function dome(x: number, ground: number, w: number, h: number): string {
  const base = h * 0.55;
  const top = ground - base;
  const r = w * 0.38;
  const cx = x + w / 2;
  let ribs = '';
  for (const k of [-0.6, -0.25, 0.25, 0.6]) ribs += `M${n(cx + k * r)} ${n(top - Math.sqrt(1 - k * k) * r)}Q${n(cx + k * r * 0.6)} ${n(top - 4)} ${n(cx + k * r)} ${top}`;
  return (
    rect(x, top, w, base) +
    facade(x, top + 4, w, base - 4, 6, 6, 10) +
    rect(cx - r - 4, top - 6, 2 * r + 8, 6) +
    `<path d="M${n(cx - r)} ${top - 6}A${n(r)} ${n(r)} 0 0 1 ${n(cx + r)} ${top - 6}Z"/>` +
    `<path class="open" d="${ribs}"/>` +
    rect(cx - 6, top - 6 - r - 12, 12, 12) +
    `<path class="open" d="M${cx} ${n(top - 6 - r - 12)}v-10"/>`
  );
}

/** Satellite dish on a roof at (x, y) */
function dish(x: number, y: number): string {
  return `<path d="M${x} ${y}l6 -10l6 10Z"/><path d="M${x - 8} ${y - 14}a14 14 0 0 0 26 -12Z"/><path class="open" d="M${x + 5} ${y - 13}l8 -7"/><circle cx="${x + 14}" cy="${y - 21}" r="2"/>`;
}

function tree(x: number, ground: number, h = 26): string {
  return `<path class="open" d="M${x} ${ground}v${-h * 0.45}"/><circle cx="${x}" cy="${n(ground - h * 0.62)}" r="${n(h * 0.3)}"/>`;
}

/** Long low hall with arches (left edge) */
function hall(x: number, ground: number, w: number, h: number): string {
  const top = ground - h;
  let arches = '';
  const count = Math.floor(w / 34);
  for (let i = 0; i < count; i++) {
    const ax = x + 10 + i * 34;
    arches += `M${ax} ${ground}V${top + 26}a10 10 0 0 1 20 0V${ground}`;
  }
  return `${rect(x, top, w, h)}<path d="M${x - 6} ${top}Q${n(x + w / 2)} ${top - 34} ${x + w + 6} ${top}Z"/><path class="open" d="${arches}M${x} ${top + 12}h${w}"/>`;
}

function rowHouses(x: number, ground: number, count: number, w = 34): string {
  let out = '';
  for (let i = 0; i < count; i++) {
    const h = 46 + ((i * 37) % 30);
    const bx = x + i * w;
    out += rect(bx, ground - h, w, h) + facade(bx, ground - h, w, h, 2, 5, 8, 7);
  }
  return out;
}

/** The skyline, 1600 × 330, ground at y = 322 */
export function skylineSvg(): string {
  const g = 322;
  const back = [
    tower(300, g, 64, 168, 4, 'flat'),
    rack(392, g, 70, 212),
    tower(520, g, 74, 246, 4, 'spire'),
    tower(760, g, 96, 236, 5, 'step'),
    tower(905, g, 70, 200, 4, 'antenna'),
    tower(1010, g, 92, 222, 5, 'slant'),
    rack(1132, g, 62, 178, 14),
    tower(1236, g, 40, 150, 2, 'spire'),
    tower(1290, g, 40, 176, 2, 'spire'),
    tower(1400, g, 58, 132, 3, 'crown'),
  ].join('');
  const front = [
    hall(28, g, 238, 92),
    vault(286, g, 156, 128),
    cylinder(468, g, 76, 168),
    antenna(612, g, 300),
    rowHouses(560, g, 1, 30),
    dome(650, g, 150, 170),
    rack(812, g, 46, 116, 13),
    rack(860, g, 46, 128, 13),
    rack(908, g, 46, 110, 13),
    vault(978, g, 134, 112),
    cylinder(1130, g, 58, 124, 2),
    tower(1204, g, 64, 132, 3, 'flat'),
    dish(1222, g - 132),
    rowHouses(1282, g, 6),
    tower(1490, g, 56, 96, 3, 'flat'),
    hall(1556, g, 120, 70),
    tree(276, g),
    tree(456, g, 22),
    tree(1120, g, 22),
    tree(1474, g, 24),
  ].join('');
  // replication links between nodes: dashed arcs that flow (style.css animates the dash offset)
  const links =
    '<path class="art-link" d="M612 22Q760 -40 941 88"/>' +
    '<path class="art-link" d="M427 112Q520 40 612 50"/>' +
    '<path class="art-link" d="M1240 172Q1190 70 1163 146"/>';
  return (
    `<svg class="skyline" viewBox="0 0 1600 330" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">` +
    `<g class="sk-back">${back}</g><g class="sk-front">${front}</g><g class="sk-links">${links}</g>` +
    `<path class="sk-ground" d="M0 ${g}H1600"/></svg>`
  );
}

export const sunSvg = (): string => {
  let rays = '';
  for (let i = 0; i < 32; i++) {
    const a = (i * Math.PI) / 16;
    const r1 = 23;
    const r2 = i % 2 ? 31 : 36;
    rays += `M${n(Math.cos(a) * r1)} ${n(Math.sin(a) * r1)}L${n(Math.cos(a) * r2)} ${n(Math.sin(a) * r2)}`;
  }
  return `<svg class="art-sun" viewBox="-40 -40 80 80" aria-hidden="true" focusable="false"><circle r="17"/><path class="art-rays" d="${rays}"/></svg>`;
};

export const cloudSvg = (): string =>
  `<svg class="art-cloud-shape" viewBox="0 0 100 44" aria-hidden="true" focusable="false"><path d="M10 40H88a10 10 0 0 0 -2 -19.8A13 13 0 0 0 64 11A17 17 0 0 0 31 15.5A11.5 11.5 0 0 0 14.6 28.6A6 6 0 0 0 10 40Z"/></svg>`;

export const planeSvg = (): string =>
  `<svg class="art-plane-shape" viewBox="0 0 120 52" aria-hidden="true" focusable="false">` +
  `<path class="art-trail" d="M2 46c18 -2 30 -12 46 -16"/>` +
  `<path d="M50 30L116 4L84 48L72 36Z"/><path d="M72 36L116 4L66 40Z"/><path class="open" d="M66 40l-2 10l10 -10"/>` +
  `</svg>`;

/** Hot-air balloon whose basket is a padlock */
export const balloonSvg = (): string =>
  `<svg class="art-balloon-shape" viewBox="0 0 60 92" aria-hidden="true" focusable="false">` +
  `<path d="M30 3C13 3 3 16 3 31c0 16 15 26 21 37h12c6 -11 21 -21 21 -37C57 16 47 3 30 3Z"/>` +
  `<path class="open" d="M30 3C21 18 20 48 24 68M30 3C39 18 40 48 36 68M30 3V68M5 28h50"/>` +
  `<path class="open" d="M24 68l1 9M36 68l-1 9"/>` +
  `<path class="open" d="M25.5 79v-3a4.5 4.5 0 0 1 9 0v3"/>` +
  `<rect x="22" y="79" width="16" height="11" rx="2"/><path class="open" d="M30 83v3"/>` +
  `</svg>`;

// ── Flat illustrations for the three steps (brand colours) ──────────────────

export const stepWalletSvg = (): string => `
<svg viewBox="0 0 120 100" aria-hidden="true" focusable="false">
  <ellipse cx="60" cy="92" rx="40" ry="5" fill="#ece9f3"/>
  <rect x="18" y="26" width="80" height="58" rx="10" fill="#836ef9"/>
  <path d="M18 38c0-7 5-12 12-12h52l-8-12H30c-7 0-12 5-12 12z" fill="#b9adfc"/>
  <rect x="64" y="44" width="40" height="24" rx="8" fill="#5b41e6"/>
  <circle cx="76" cy="56" r="5" fill="#a0055d"/>
  <path d="M26 26l46-14 6 14z" fill="#ffffff" opacity=".9"/>
  <g fill="none" stroke="#200052" stroke-width="4.5" stroke-linecap="round">
    <circle cx="84" cy="14" r="8"/>
    <path d="M92 14h22M108 14v7M101 14v5"/>
  </g>
</svg>`;

export const stepUploadSvg = (): string => `
<svg viewBox="0 0 120 100" aria-hidden="true" focusable="false">
  <ellipse cx="54" cy="92" rx="38" ry="5" fill="#ece9f3"/>
  <path d="M26 10h40l18 18v58a4 4 0 0 1-4 4H26a4 4 0 0 1-4-4V14a4 4 0 0 1 4-4z" fill="#ffffff" stroke="#dcd8e6" stroke-width="2"/>
  <path d="M66 10v18h18" fill="#efebff" stroke="#dcd8e6" stroke-width="2"/>
  <path d="M32 40h34M32 50h40M32 60h28" stroke="#dcd8e6" stroke-width="4" stroke-linecap="round"/>
  <rect x="40" y="64" width="26" height="20" rx="4" fill="#836ef9"/>
  <path d="M45 64v-5a8 8 0 0 1 16 0v5" fill="none" stroke="#836ef9" stroke-width="4"/>
  <circle cx="53" cy="73" r="3" fill="#ffffff"/>
  <rect x="92" y="22" width="14" height="14" rx="3" fill="#200052"/>
  <rect x="98" y="46" width="12" height="12" rx="3" fill="#a0055d"/>
  <rect x="90" y="66" width="12" height="12" rx="3" fill="#b9adfc"/>
  <path d="M86 36l4-4M88 54l6-1M86 70l4 1" stroke="#cfcbe0" stroke-width="2" stroke-linecap="round"/>
</svg>`;

export const stepShareSvg = (): string => `
<svg viewBox="0 0 120 100" aria-hidden="true" focusable="false">
  <circle cx="60" cy="48" r="40" fill="#efebff"/>
  <path d="M30 86c2-16 14-24 30-24s28 8 30 24" fill="#836ef9"/>
  <circle cx="60" cy="40" r="17" fill="#f3c9a8"/>
  <path d="M43 38c0-11 8-18 17-18s17 7 17 18c-4-6-10-9-17-9s-13 3-17 9z" fill="#2b2433"/>
  <path d="M48 47c3 7 7 10 12 10s9-3 12-10c-2 12-6 16-12 16s-10-4-12-16z" fill="#2b2433"/>
  <circle cx="92" cy="20" r="11" fill="#a0055d"/>
  <path d="M87 20l4 4 7-8" fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <g fill="none" stroke="#200052" stroke-width="4" transform="rotate(-40 22 66)">
    <rect x="6" y="60" width="20" height="12" rx="6"/>
    <rect x="18" y="60" width="20" height="12" rx="6"/>
  </g>
</svg>`;
