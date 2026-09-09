/**
 * Store graphics, rendered rather than drawn.
 *
 * The Chrome Web Store and Edge Add-ons both demand images at exact pixel
 * sizes, and both reject anything off by a pixel. Hand-made images in an image
 * editor satisfy that once and then go stale: the UI changes, the screenshots
 * do not, and the listing ends up showing a version of the product that no
 * longer exists.
 *
 * So the assets are HTML, rendered by headless Chromium at the exact required
 * size. Regenerating them after a UI change is one command.
 *
 * NO DEPENDENCY IS ADDED. Chromium is driven through its own command line
 * (`--headless --screenshot --window-size`), not through Playwright or Puppeteer
 * — this project has zero runtime dependencies and there is no reason for a
 * screenshot script to be the thing that changes that.
 *
 * Run with `npm run assets`. Output lands in `store-assets/`.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'store-assets');
const workDir = resolve(outDir, '.work');

/**
 * Finds a browser to render with, PREFERRING the headless shell.
 *
 * This preference is not cosmetic. Full Chromium in `--headless` mode subtracts
 * window chrome from `--window-size` when it lays the page out, but captures
 * the full requested size: ask for 440x280 and the layout viewport is 440x194
 * while the PNG is 440x280, so the bottom 86 pixels are outside the page
 * entirely. A centred design silently loses its lower third, and the output is
 * still exactly the right dimensions — so the size check below passes and the
 * damage is invisible until someone looks at the image.
 *
 * `headless_shell` has no window chrome and lays out at exactly the requested
 * size. `assertFullBleed` below proves it before anything is rendered.
 */
function findChromium() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PLAYWRIGHT_BROWSERS_PATH &&
      join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium_headless_shell-1194/chrome-linux/headless_shell'),
    '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell',
    process.env.PLAYWRIGHT_BROWSERS_PATH && join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1194/chrome-linux/chrome'),
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);

  for (const candidate of candidates) if (existsSync(candidate)) return candidate;

  console.error('No Chromium found. Set CHROME_PATH to a Chrome or Chromium binary.');
  console.error('Looked in:');
  for (const candidate of candidates) console.error(`  ${candidate}`);
  process.exit(1);
}

const chromium = findChromium();

mkdirSync(outDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

function runChromium(target, width, height, pagePath) {
  execFileSync(
    chromium,
    [
      // headless_shell is always headless and rejects the flag.
      ...(/headless_shell/.test(chromium) ? [] : ['--headless']),
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      // Deterministic rendering: without this the screenshot can differ between
      // machines by a subpixel and the diff is noise in every commit.
      '--disable-lcd-text',
      `--screenshot=${target}`,
      `--window-size=${width},${height}`,
      `file://${pagePath}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );
}

/** Renders one HTML string to a PNG of exactly `width` x `height`. */
function shoot(name, width, height, html) {
  const page = join(workDir, `${name}.html`);
  const target = join(outDir, `${name}.png`);
  writeFileSync(page, html);

  runChromium(target, width, height, page);

  const bytes = readFileSync(target);
  const actualWidth = bytes.readUInt32BE(16);
  const actualHeight = bytes.readUInt32BE(20);
  if (actualWidth !== width || actualHeight !== height) {
    console.error(`${name}.png rendered ${actualWidth}x${actualHeight}, wanted ${width}x${height}.`);
    process.exit(1);
  }
  console.log(`  ${name}.png  ${width}x${height}  ${(bytes.length / 1024).toFixed(1)} KB`);
}


/**
 * Decodes a PNG far enough to read its pixels. No dependency.
 *
 * Only used by the full-bleed check below, which needs actual pixel values —
 * the image dimensions alone cannot detect the bug it guards against.
 */
function decodePng(path) {
  const data = readFileSync(path);
  let pos = 8;
  let idat = Buffer.alloc(0);
  let width = 0;
  let height = 0;
  let colorType = 0;

  while (pos < data.length) {
    const length = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = data.readUInt32BE(pos + 8);
      height = data.readUInt32BE(pos + 12);
      colorType = data[pos + 17];
    }
    if (type === 'IDAT') idat = Buffer.concat([idat, data.subarray(pos + 8, pos + 8 + length)]);
    pos += 12 + length;
  }

  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const raw = inflateSync(idat);
  const rows = [];
  let previous = Buffer.alloc(stride);
  let offset = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[offset++];
    const line = Buffer.from(raw.subarray(offset, offset + stride));
    offset += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = previous[x];
      const c = x >= bpp ? previous[x - bpp] : 0;
      if (filter === 1) line[x] = (line[x] + a) & 255;
      else if (filter === 2) line[x] = (line[x] + b) & 255;
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
    }
    rows.push(line);
    previous = line;
  }

  return { width, height, bpp, rows };
}

/**
 * Proves the renderer lays out at the full requested size before anything real
 * is rendered.
 *
 * A page painted edge to edge in one colour must come back as that colour in
 * every row. If the browser subtracts window chrome from the layout viewport,
 * the lower rows fall outside the page and come back as the default background
 * — and the image is still exactly the right dimensions, which is precisely why
 * a size check cannot catch it.
 */
function assertFullBleed() {
  const probe = join(workDir, '_probe.html');
  const target = join(workDir, '_probe.png');
  const [width, height] = [320, 240];
  writeFileSync(
    probe,
    `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{margin:0;padding:0}
     html,body{width:${width}px;height:${height}px;background:#000}
     .fill{position:absolute;inset:0;background:#ff0000}</style></head><body><div class="fill"></div></body></html>`
  );

  runChromium(target, width, height, probe);
  const { rows, bpp } = decodePng(target);
  const bad = [];
  for (let y = 0; y < rows.length; y++) {
    const middle = Math.floor(rows[y].length / bpp / 2) * bpp;
    if (rows[y][middle] !== 255 || rows[y][middle + 1] !== 0) bad.push(y);
  }

  if (bad.length > 0) {
    console.error(`\nThe renderer is not laying out at the requested size.`);
    console.error(`A full-bleed ${width}x${height} page came back with ${bad.length} row(s) outside the page,`);
    console.error(`starting at row ${bad[0]}. Every asset would silently lose its lower portion.`);
    console.error(`\nBrowser: ${chromium}`);
    console.error('Use the headless shell (chromium_headless_shell-*/chrome-linux/headless_shell),');
    console.error('or set CHROME_PATH to one. Full Chromium subtracts window chrome from --window-size.');
    process.exit(1);
  }
}

// --------------------------------------------------------------- design

const CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0d1117;
    color: #e6edf3;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
  }
  .accent { color: #10b9a8; }
  .muted { color: #9198a1; }
  .card {
    background: #161b22; border: 1px solid #30363d; border-radius: 10px;
  }
  .pill {
    display: inline-block; padding: 4px 11px; border-radius: 999px;
    font-size: 13px; border: 1px solid #30363d; color: #9198a1;
  }
  .ok { color: #3fb950; } .warn { color: #d29922; } .fail { color: #f85149; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
`;

/** The mark, drawn as SVG so it is crisp at any size. */
function logo(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 128 128" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="128" height="128" rx="26" fill="#0d1117"/>
    <rect x="1.5" y="1.5" width="125" height="125" rx="24.5" stroke="#10b9a8" stroke-width="3"/>
    <path d="M28 92 L54 44 L74 78 L88 56 L100 92 Z" fill="#10b9a8" fill-opacity="0.18"/>
    <path d="M28 92 L54 44 L74 78 L88 56 L100 92" stroke="#10b9a8" stroke-width="5"
          stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="54" cy="44" r="7" fill="#0d1117" stroke="#10b9a8" stroke-width="4.5"/>
    <circle cx="88" cy="56" r="6" fill="#0d1117" stroke="#58a6ff" stroke-width="4"/>
    <path d="M22 104 H106" stroke="#30363d" stroke-width="4" stroke-linecap="round"/>
  </svg>`;
}

/**
 * Wraps a body at EXACT pixel dimensions rather than viewport units.
 *
 * `100vh` is not reliably the capture height in headless Chromium — the
 * viewport it lays out against and the region it captures can differ, which
 * silently pushes a centred design off centre. The size is known here, so it is
 * stated here.
 */
function page(body, width, height, extra = '') {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${CSS}
    html, body { width: ${width}px; height: ${height}px; }
    .stage { width: ${width}px; height: ${height}px; overflow: hidden; }
    ${extra}</style></head><body><div class="stage">${body}</div></body></html>`;
}

assertFullBleed();

// --------------------------------------------------------------- screenshots

/**
 * Four screenshots, each making one claim the listing makes.
 *
 * Deliberately not a photograph of the whole UI four times: a store screenshot
 * is read at thumbnail size, so each one carries a single legible idea.
 */

const SHOT = `
  .wrap { display: flex; flex-direction: column; height: 100%; padding: 44px 56px 34px; gap: 20px; }
  h1 { font-size: 40px; font-weight: 650; letter-spacing: -0.02em; }
  .sub { font-size: 20px; color: #9198a1; max-width: 900px; line-height: 1.45; }
  .body { flex: 1; display: flex; gap: 18px; min-height: 0; }
  .panel { flex: 1; padding: 22px 24px; display: flex; flex-direction: column; gap: 12px; }
  .panel h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .09em; color: #9198a1; font-weight: 600; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 14px; font-size: 17px; padding: 7px 0; border-bottom: 1px solid #21262d; }
  .row:last-child { border-bottom: none; }
  .foot { font-size: 15px; color: #6e7681; }
`;

shoot(
  'screenshot-1',
  1280,
  800,
  page(
    `<div class="wrap">
      <div style="display:flex;align-items:center;gap:16px">
        ${logo(52)}
        <div>
          <h1>Convert 30+ formats, entirely offline</h1>
        </div>
      </div>
      <p class="sub">GIS, CAD, survey, LiDAR, raster and mining data. Nothing is uploaded — every file is
      read, converted and written inside your own browser.</p>
      <div class="body">
        <div class="card panel">
          <h2>Reads</h2>
          <div class="row"><span>Shapefile · GeoJSON · KML / KMZ</span><span class="ok">✓</span></div>
          <div class="row"><span>DXF · DWG · LandXML</span><span class="ok">✓</span></div>
          <div class="row"><span>LAS · PLY · PTS · XYZ</span><span class="ok">✓</span></div>
          <div class="row"><span>GeoTIFF · ASCII Grid</span><span class="ok">✓</span></div>
          <div class="row"><span>CSV / PNEZD · XLSX · Surpac</span><span class="ok">✓</span></div>
        </div>
        <div class="card panel">
          <h2>Writes</h2>
          <div class="row"><span>GeoJSON · TopoJSON · Shapefile</span><span class="ok">✓</span></div>
          <div class="row"><span>KML · KMZ with styled balloons</span><span class="ok">✓</span></div>
          <div class="row"><span>DXF with real layers</span><span class="ok">✓</span></div>
          <div class="row"><span>LAS · GeoTIFF · MIF/MID</span><span class="ok">✓</span></div>
          <div class="row"><span>GPX · WKT · WKB · GML · OSM</span><span class="ok">✓</span></div>
        </div>
      </div>
      <p class="foot">No account. No server. No telemetry. Works with the network disconnected.</p>
    </div>`,
    1280, 800, SHOT
  )
);

shoot(
  'screenshot-2',
  1280,
  800,
  page(
    `<div class="wrap">
      <h1>It tells you the cost <span class="accent">before</span> you pay it</h1>
      <p class="sub">Every output format is graded against your data across eleven axes before anything
      is written. Losses are named and counted, not discovered weeks later.</p>
      <div class="card panel" style="flex:1">
        <h2>What will be lost — converting to Shapefile</h2>
        <div class="row"><span><span class="fail">●</span> Attribute names</span>
          <span class="mono muted" style="font-size:15px">3 fields exceed DBF's 10-character limit</span></div>
        <div class="row"><span class="mono muted" style="font-size:15px;padding-left:22px">sample_description → sample_des · collar_elevation → collar_ele</span><span></span></div>
        <div class="row"><span><span class="warn">●</span> Curves</span>
          <span class="mono muted" style="font-size:15px">412 arcs densified at 0.01 m sagitta</span></div>
        <div class="row"><span><span class="warn">●</span> Mixed geometry</span>
          <span class="mono muted" style="font-size:15px">split into 3 files — Shapefile holds one type</span></div>
        <div class="row"><span><span class="ok">●</span> Coordinates</span>
          <span class="mono muted" style="font-size:15px">full precision retained</span></div>
        <div class="row"><span><span class="ok">●</span> CRS</span>
          <span class="mono muted" style="font-size:15px">EPSG:32645 written to .prj</span></div>
      </div>
      <p class="foot">That silent join break is the one you would otherwise find after delivery.</p>
    </div>`,
    1280, 800, SHOT
  )
);

shoot(
  'screenshot-3',
  1280,
  800,
  page(
    `<div class="wrap">
      <h1>QA means it read its own output back</h1>
      <p class="sub">A green PASS means the file was re-imported and compared with the source, axis by
      axis, in your data's own units. A format with no reader reports NOT VALIDATED — never PASS.</p>
      <div class="card panel" style="flex:1">
        <h2>Measured comparison — source vs output</h2>
        <div class="row" style="color:#9198a1;font-size:14px"><span style="flex:2">AXIS</span><span style="flex:2">SOURCE</span><span style="flex:2">OUTPUT</span><span style="flex:2">DIFFERENCE</span><span style="flex:1;text-align:right">VERDICT</span></div>
        <div class="row"><span style="flex:2">Feature count</span><span class="mono" style="flex:2">4,182</span><span class="mono" style="flex:2">4,182</span><span class="mono" style="flex:2">0</span><span class="ok" style="flex:1;text-align:right">EXACT</span></div>
        <div class="row"><span style="flex:2">Vertex count</span><span class="mono" style="flex:2">96,431</span><span class="mono" style="flex:2">96,431</span><span class="mono" style="flex:2">0</span><span class="ok" style="flex:1;text-align:right">EXACT</span></div>
        <div class="row"><span style="flex:2">Area</span><span class="mono" style="flex:2">184,203.44 m²</span><span class="mono" style="flex:2">184,203.45 m²</span><span class="mono" style="flex:2">0.01 m²</span><span class="ok" style="flex:1;text-align:right">PASS</span></div>
        <div class="row"><span style="flex:2">Perimeter</span><span class="mono" style="flex:2">21,884.10 m</span><span class="mono" style="flex:2">21,884.10 m</span><span class="mono" style="flex:2">0.00 m</span><span class="ok" style="flex:1;text-align:right">EXACT</span></div>
        <div class="row"><span style="flex:2">Coordinates</span><span class="mono" style="flex:2">—</span><span class="mono" style="flex:2">—</span><span class="mono" style="flex:2">max drift 0.0004 m</span><span class="ok" style="flex:1;text-align:right">PASS</span></div>
        <div class="row"><span style="flex:2">CRS</span><span class="mono" style="flex:2">EPSG:32645</span><span class="mono" style="flex:2">EPSG:32645</span><span class="mono" style="flex:2">same</span><span class="ok" style="flex:1;text-align:right">EXACT</span></div>
      </div>
      <p class="foot">The number is the deliverable. "PASS" alone cannot tell you whether a difference is rounding or a defect.</p>
    </div>`,
    1280, 800, SHOT
  )
);

shoot(
  'screenshot-4',
  1280,
  800,
  page(
    `<div class="wrap">
      <h1>Cadastral line work becomes labelled parcels</h1>
      <p class="sub">Boundary lines are assembled into closed polygons within a tolerance you set, and
      the plot number drawn inside each parcel is attached to it as an attribute.</p>
      <div class="body">
        <div class="card panel">
          <h2>Before — a CAD drawing</h2>
          <div class="row"><span>LINE entities</span><span class="mono muted">8,412</span></div>
          <div class="row"><span>TEXT entities</span><span class="mono muted">1,036</span></div>
          <div class="row"><span>Closed polygons</span><span class="fail mono">0</span></div>
          <div class="row"><span>Attributes</span><span class="fail mono">none</span></div>
          <p class="foot" style="margin-top:auto">Unusable as GIS: no parcels, no plot numbers.</p>
        </div>
        <div class="card panel">
          <h2>After — GIS parcels</h2>
          <div class="row"><span>Parcels built</span><span class="ok mono">1,036</span></div>
          <div class="row"><span>Plot numbers attached</span><span class="ok mono">1,036</span></div>
          <div class="row"><span>Gaps closed</span><span class="mono muted">≤ 0.010 m, each recorded</span></div>
          <div class="row"><span>Boundaries left open</span><span class="warn mono">0 — all within tolerance</span></div>
          <p class="foot" style="margin-top:auto">Source text kept. Every closed gap reported.</p>
        </div>
      </div>
      <p class="foot">Also: borehole collars joined to interval logs, exported as Google Earth core-log balloons.</p>
    </div>`,
    1280, 800, SHOT
  )
);

// --------------------------------------------------------------- promo tiles

shoot(
  'promo-small',
  440,
  280,
  page(
    `<div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:15px;
                background:radial-gradient(circle at 50% 38%, #16272f 0%, #0d1117 72%);text-align:center;padding:18px">
      ${logo(84)}
      <div style="font-size:24px;font-weight:660;letter-spacing:-0.015em;line-height:1.2">BhuNex GIS Converter</div>
      <div style="font-size:15px;color:#adb6c0;line-height:1.55">GIS · CAD · Survey · LiDAR · Mining<br>
        <span style="color:#10b9a8;font-weight:500">Converted offline, on your machine</span></div>
    </div>`,
    440, 280
  )
);

shoot(
  'promo-marquee',
  1400,
  560,
  page(
    `<div style="height:100%;display:flex;align-items:center;gap:64px;padding:0 90px;
                background:radial-gradient(circle at 22% 50%, #16272f 0%, #0d1117 62%)">
      ${logo(190)}
      <div>
        <div style="font-size:52px;font-weight:680;letter-spacing:-0.025em;line-height:1.12">BhuNex GIS Converter</div>
        <div style="font-size:25px;color:#9198a1;margin-top:16px;line-height:1.45">
          Convert GIS, CAD, survey, LiDAR and mining data<br>
          <span style="color:#10b9a8">entirely on your own machine.</span>
        </div>
        <div style="margin-top:26px;display:flex;gap:9px;flex-wrap:wrap">
          <span class="pill">Shapefile</span><span class="pill">DXF</span><span class="pill">KMZ</span>
          <span class="pill">LAS</span><span class="pill">GeoTIFF</span><span class="pill">LandXML</span>
          <span class="pill">Surpac</span><span class="pill">+ 23 more</span>
        </div>
      </div>
    </div>`,
    1400, 560
  )
);

shoot(
  'edge-logo-300',
  300,
  300,
  page(
    `<div style="height:100%;display:grid;place-items:center;background:#0d1117">${logo(252)}</div>`,
    300, 300
  )
);

rmSync(workDir, { recursive: true, force: true });

console.log(`\nStore assets written to store-assets/`);
console.log('Chrome needs at least one 1280x800 screenshot and the 440x280 tile.');
console.log('Edge needs at least one screenshot and the 300x300 logo.');
