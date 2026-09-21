/**
 * The two store screenshots that are photographs of the running extension.
 *
 * WHY THESE ARE NOT MADE BY `make-store-assets.mjs`
 *
 * That script renders hand-written HTML at exact sizes: each image carries one
 * legible idea, which is the right shape for the two that explain what the tool
 * is for. But a listing whose every image is a designed card shows the reviewer
 * nothing of the product, and the Chrome Web Store expects the screenshots to
 * show the actual extension. So two of the four are captured here, from the
 * real workspace, with a real file loaded.
 *
 * NO DEPENDENCY IS ADDED, which is the same rule `make-store-assets.mjs` keeps.
 * Driving the UI needs more than `--screenshot` can do — a file has to be put
 * into a file input, a CRS chosen, a basemap switched on — so Chromium is
 * driven over its own DevTools Protocol through Node's built-in `WebSocket`
 * (Node 22+). No Playwright, no Puppeteer, nothing in package.json.
 *
 * WHAT IS IN THE PICTURES
 *
 *   screenshot-2  The operator's own 3.9 MB mining DXF, on its surveyed grid
 *                 over an OpenStreetMap basemap. A DXF declares no CRS, so this
 *                 is the assigned-CRS case: the whole point is that the drawing
 *                 lands where the survey says it is.
 *   screenshot-4  The same file converted, showing the output the tool wrote
 *                 and the queue row reporting the result.
 *
 * Both are 1280x800, which is what both stores want, and the size is asserted
 * after capture rather than assumed.
 *
 * Run with `npm run assets:ui`. Needs `npm run build` first — the server below
 * serves `dist/`, not source.
 *
 * TLS. Tile hosts are reached directly. In a sandbox whose egress is a
 * TLS-intercepting proxy, Chromium will not trust the proxy's CA and the tiles
 * fail; set CAPTURE_INSECURE_TLS=1 to add --ignore-certificate-errors there.
 * It is off by default because a committed script should not weaken TLS on a
 * normal machine.
 */

import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const OUT = join(ROOT, 'store-assets');
const WIDTH = 1280;
const HEIGHT = 800;

/** The operator's own file. Real data, not a fixture invented for a picture. */
const SAMPLE_DXF = join(ROOT, '1_Trial_Feedback_Files', 'imported file', 'RAM_Pakhar-115.13 Ha Entity LMS Final Data.dxf');
/** The grid it was surveyed on. A DXF declares none; the surveyor assigns it. */
const SAMPLE_EPSG = '32645';

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm', '.map': 'application/json',
};

function findChromium() {
  const candidates = [
    process.env.CHROME_PATH,
    '/opt/pw-browsers/chromium',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const path of candidates) if (existsSync(path)) return path;
  throw new Error('No Chromium found. Set CHROME_PATH to a Chrome or Chromium binary.');
}

/** Serves dist/ so the workspace runs as a page. */
function serve() {
  const server = createServer((request, response) => {
    const path = join(DIST, decodeURIComponent(request.url.split('?')[0]));
    if (!path.startsWith(DIST) || !existsSync(path) || statSync(path).isDirectory()) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' });
    response.end(readFileSync(path));
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port })));
}

// ------------------------------------------------------------ DevTools client

/** One CDP connection, with `send` returning the command's result. */
async function connect(wsUrl) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((ok, fail) => {
    socket.addEventListener('open', ok, { once: true });
    socket.addEventListener('error', () => fail(new Error('DevTools socket failed')), { once: true });
  });
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error) entry.fail(new Error(`${message.error.message} (${entry.method})`));
    else entry.ok(message.result);
  });
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      const id = nextId++;
      pending.set(id, { ok, fail, method });
      socket.send(JSON.stringify({ id, method, params }));
    });
  return { send, close: () => socket.close() };
}

const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

/** Runs an expression in the page and returns its JSON value. */
async function evaluate(cdp, expression) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(`page threw: ${exceptionDetails.text}`);
  return result.value;
}

/** Waits until an expression is truthy, or gives up with a useful message. */
async function until(cdp, expression, what, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(cdp, expression)) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(500);
  }
}

/** A PNG's real pixel size, read from the IHDR rather than trusted. */
function pngSize(buffer) {
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * Refuses to ship a picture of an empty canvas.
 *
 * A store screenshot showing a blank drawing area is the same class of failure
 * this tool exists to catch elsewhere: well-formed, plausible, and wrong. It
 * happens whenever the view is left off the data — a fit that did not fire puts
 * the camera at the grid origin, and the canvas comes out a flat field of one
 * colour with the whole survey somewhere off screen.
 *
 * So the canvas is sampled and the distinct colours counted. A drawing over a
 * basemap runs to many hundreds; an empty one measured 44 — grid lines and
 * antialiasing on the background, which is why the threshold is well above
 * that rather than just above zero. A guard that cannot fail is not a guard.
 */
async function assertCanvasHasContent(cdp, minimumColours = 150) {
  const found = await evaluate(cdp, `
    (() => {
      const canvases = [...document.querySelectorAll('canvas')];
      const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      if (!canvas) return -1;
      const scratch = document.createElement('canvas');
      scratch.width = 160;
      scratch.height = 100;
      const context = scratch.getContext('2d');
      context.drawImage(canvas, 0, 0, scratch.width, scratch.height);
      const { data } = context.getImageData(0, 0, scratch.width, scratch.height);
      const seen = new Set();
      for (let i = 0; i < data.length; i += 4) {
        seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      }
      return seen.size;
    })()
  `);
  if (found < minimumColours) {
    throw new Error(
      `the canvas looks empty (${found} distinct colours, expected at least ${minimumColours}). ` +
        'The view is probably not on the data — check that Fit fired.'
    );
  }
  console.log(`  canvas has content (${found} distinct colours)`);
}

async function capture(cdp, name) {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buffer = Buffer.from(data, 'base64');
  const size = pngSize(buffer);
  if (size.width !== WIDTH || size.height !== HEIGHT) {
    throw new Error(`${name} came out ${size.width}x${size.height}, needs ${WIDTH}x${HEIGHT}`);
  }
  const path = join(OUT, `${name}.png`);
  writeFileSync(path, buffer);
  console.log(`  ${name}.png  ${size.width}x${size.height}  ${(buffer.length / 1024).toFixed(0)} kB`);
}

// ------------------------------------------------------------------ the shoot

async function main() {
  if (!existsSync(DIST)) throw new Error('dist/ is missing. Run `npm run build` first.');
  if (!existsSync(SAMPLE_DXF)) throw new Error(`Sample drawing not found:\n  ${SAMPLE_DXF}`);
  mkdirSync(OUT, { recursive: true });

  const { server, port } = await serve();
  const binary = findChromium();
  const profile = join(ROOT, 'node_modules', '.cache', 'capture-profile');
  mkdirSync(profile, { recursive: true });

  const flags = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--force-color-profile=srgb',
    '--no-sandbox',
    '--disable-gpu',
    `http://127.0.0.1:${port}/src/workspace/index.html`,
  ];
  if (process.env.CAPTURE_INSECURE_TLS === '1') flags.unshift('--ignore-certificate-errors');

  const child = execFile(binary, flags);
  // Chromium prints the BROWSER endpoint, which has no Page domain. Its host
  // and port are what is wanted: /json/list then names the page target, and
  // that is the socket a screenshot can be taken over.
  const browserWs = await new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('Chromium did not report a DevTools endpoint')), 30_000);
    child.stderr.on('data', (chunk) => {
      const found = String(chunk).match(/ws:\/\/[^\s]+/);
      if (found) {
        clearTimeout(timer);
        ok(found[0]);
      }
    });
  });
  const origin = `http://${new URL(browserWs).host}`;
  const pageWs = await (async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const targets = await fetch(`${origin}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
      if (Date.now() > deadline) throw new Error('No page target appeared.');
      await wait(300);
    }
  })();

  const cdp = await connect(pageWs);
  try {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('DOM.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    });
    // Booted means the format list has rendered, not merely that an input
    // exists. `DOM.getDocument` takes a SNAPSHOT, and a node id from a document
    // the app is still building goes stale the moment it re-renders — the file
    // then lands in a detached input and nothing is queued, silently.
    await until(cdp, 'document.querySelectorAll("button.fcard").length > 0', 'the workspace to boot');
    await wait(1500);

    // --- the drawing goes in, through the real file input -------------------
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [SAMPLE_DXF] });
    await until(cdp, 'document.querySelectorAll(".qrow").length > 0', 'the file to be queued');
    await until(
      cdp,
      'Array.from(document.querySelectorAll(".qrow")).some((r) => /ready/.test(r.textContent))',
      'inspection to finish'
    );

    // --- its grid is assigned, which is what a DXF always needs -------------
    await evaluate(cdp, `
      (() => {
        const tab = [...document.querySelectorAll('button.rtab')].find((b) => b.textContent.trim() === 'Data');
        tab?.click();
        return true;
      })()
    `);
    await wait(600);
    await evaluate(cdp, `
      (() => {
        const crs = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'CRS');
        crs?.click();
        return true;
      })()
    `);
    await until(cdp, 'document.querySelectorAll("#inspectorBody select.select").length >= 1', 'the CRS panel');
    await evaluate(cdp, `
      (() => {
        const select = document.querySelectorAll('#inspectorBody select.select')[0];
        select.value = '${SAMPLE_EPSG}';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return select.value;
      })()
    `);
    await wait(5000);

    // --- the basemap, so the drawing is shown where it actually is ----------
    await evaluate(cdp, 'document.querySelector(".mapctl__btn")?.click(), true');
    await until(cdp, 'Boolean(document.querySelector(".mapmenu .mapmenu__check"))', 'the basemap menu');
    await evaluate(cdp, 'document.querySelector(".mapmenu .mapmenu__check").click(), true');
    await wait(7000);
    await evaluate(cdp, 'document.querySelector(".mapmenu")?.remove(), true');
    await wait(500);

    // Back to Home before fitting. Fit lives on the CANVAS toolbar, which only
    // exists under the Home ribbon tab — and the CRS panel above needed the
    // Data tab. Left on Data the Fit button is still in the DOM but detached
    // (`offsetParent === null`), so clicking it does nothing at all and the
    // picture comes out as an empty canvas with no error anywhere.
    await evaluate(cdp, `
      (() => {
        const home = [...document.querySelectorAll('button.rtab')].find((b) => b.textContent.trim() === 'Home');
        home?.click();
        return true;
      })()
    `);
    await wait(1200);
    const fitted = await evaluate(cdp, `
      (() => {
        const fit = [...document.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === 'Fit' && b.offsetParent !== null);
        fit?.click();
        return Boolean(fit);
      })()
    `);
    if (!fitted) throw new Error('No visible Fit button — the canvas toolbar is not on screen.');
    await wait(5000);
    await assertCanvasHasContent(cdp);

    console.log('\ncapturing:');
    await capture(cdp, 'screenshot-2');

    // --- converted, so the second picture shows a result --------------------
    await evaluate(cdp, `
      (() => {
        const card = [...document.querySelectorAll('button.fcard')].find((c) => /GeoJSON/.test(c.textContent));
        card?.click();
        return true;
      })()
    `);
    await wait(800);
    await evaluate(cdp, `
      (() => {
        const go = [...document.querySelectorAll('button')].find((b) => /^Convert$/.test(b.textContent.trim()) && !b.disabled);
        go?.click();
        return true;
      })()
    `);
    await until(
      cdp,
      'Array.from(document.querySelectorAll(".qrow")).some((r) => /pass|done|warning/i.test(r.textContent))',
      'the conversion to finish',
      120_000
    );
    await wait(2500);
    await capture(cdp, 'screenshot-4');
  } finally {
    cdp.close();
    child.kill();
    server.close();
  }

  console.log('\nTwo of the four store screenshots are now photographs of the running extension.');
  console.log('The other two stay as rendered cards — see make-store-assets.mjs.');
}

main().catch((error) => {
  console.error(`\nCapture failed: ${error.message}`);
  process.exit(1);
});
