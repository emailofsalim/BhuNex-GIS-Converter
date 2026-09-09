/**
 * Packages dist/ into dist-zip/universal-bhunex-converter-<version>.zip using only
 * Node built-ins, so CI needs no zip binary and the produced archive is the same
 * on every runner.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync, crc32 } from 'node:zlib';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(root, 'dist');
const outDir = resolve(root, 'dist-zip');

if (!existsSync(distDir)) {
  console.error('dist/ not found — run `npm run build` first.');
  process.exit(1);
}

const version = JSON.parse(readFileSync(resolve(root, 'extension/manifest.json'), 'utf8')).version;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * A note placed at the ROOT of the ZIP.
 *
 * People extract the archive and are then looking at a folder of build output
 * with no idea what to do with it — and the one mistake that follows costs an
 * evening: selecting the wrong folder, or extracting into OneDrive where the
 * files become cloud placeholders the browser cannot read. Putting the
 * instructions where they land, rather than only in a README on a website
 * nobody has open, is the cheapest fix available.
 */
const INSTALL_NOTE = `UNIVERSAL BHUNEX CONVERTER — HOW TO INSTALL
============================================================

You are looking at the extension folder. It is ready to load.

1. MOVE THIS FOLDER SOMEWHERE PERMANENT AND LOCAL.

   Good:  C:\\Extensions\\universal-bhunex-converter
   Bad:   anywhere under OneDrive, Desktop, Documents or Downloads

   On a work laptop those folders are usually synced to OneDrive, which
   replaces files with cloud placeholders. The browser reads extension files
   directly and cannot trigger the download, so it reports

       "Manifest file is missing or unreadable"

   even though File Explorer shows manifest.json sitting right there.

   The browser re-reads this folder every time it starts, so wherever you put
   it, leave it there. Deleting or moving it uninstalls the extension.

2. OPEN THE EXTENSIONS PAGE.

   Microsoft Edge:  edge://extensions
   Google Chrome:   chrome://extensions

3. TURN ON "DEVELOPER MODE".

   Edge:   toggle at the bottom-left
   Chrome: toggle at the top-right

4. CLICK "LOAD UNPACKED" AND SELECT THIS FOLDER.

   Select the folder that contains manifest.json — the one this file is in.
   Not the folder above it. If you can see manifest.json listed beside this
   file, you have the right one.

5. CLICK THE TOOLBAR ICON, THEN "OPEN CONVERTER WORKSPACE".

------------------------------------------------------------
IF IT STILL SAYS THE MANIFEST IS MISSING OR UNREADABLE

Check manifest.json in this folder:
  - Size should be roughly 1-2 KB, NOT 0 bytes.
  - If there is a Status column, it should show a solid green tick, not a
    blue cloud outline. A cloud outline means the contents are not on this
    machine.
  - Open it in Notepad. If it opens and starts with "{", the file is fine and
    the folder is right.

If it is blank or will not open, it is a OneDrive placeholder. Go back to
step 1 and move this folder outside OneDrive.

------------------------------------------------------------
WHAT THIS EXTENSION DOES

Converts GIS, survey, CAD, LiDAR and mining data between formats — entirely
on your own machine. Nothing is uploaded. It requests no access to any
website and contacts no server. Disconnect from the internet and it works
exactly the same.

Optional: DWG support needs a small local helper. Every other format works
without it, and the permission is only requested if you convert a DWG.

Source and full documentation:
https://github.com/emailofsalim/Universal-Converter
`;

const files = walk(distDir).sort();
const locals = [];
const centrals = [];
let offset = 0;

// The note is a synthetic entry: it exists in the archive but not in dist/, so
// the loaded extension is unaffected by it. Browsers ignore unknown files.
const entries = [
  { name: 'INSTALL-FIRST.txt', data: Buffer.from(INSTALL_NOTE.replace(/\n/g, '\r\n'), 'utf8') },
  ...files.map((file) => ({
    // ZIP paths are always forward-slashed, regardless of the build platform.
    name: relative(distDir, file).split('\\').join('/'),
    data: readFileSync(file),
  })),
];

for (const entry of entries) {
  const name = Buffer.from(entry.name, 'utf8');
  const data = entry.data;
  const deflated = deflateRawSync(data, { level: 9 });
  // Storing beats deflating when compression makes the entry larger.
  const stored = deflated.length >= data.length;
  const body = stored ? data : deflated;
  const method = stored ? 0 : 8;
  const sum = crc32(data) >>> 0;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  locals.push(local, name, body);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + body.length;
}

const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
// `entries.length`, NOT `files.length`: INSTALL-FIRST.txt is a synthetic entry
// that exists in the archive but not in dist/. Under-reporting the count by one
// makes a strict extractor read that many central-directory records, then find
// another record's signature where it expected the end of the archive.
//
// The tolerant readers (Node, Python, 7-Zip, macOS) scan and recover, so the
// archive looks fine. `unzip` reports "expected central file header signature
// not found", and Windows Explorer — which every Windows user extracts with —
// can extract partially and silently. A partial extract missing manifest.json
// is reported by the browser as "Manifest file is missing or unreadable".
eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);

mkdirSync(outDir, { recursive: true });
const target = resolve(outDir, `universal-bhunex-converter-${version}.zip`);
writeFileSync(target, Buffer.concat([...locals, centralBuf, eocd]));
console.log(`packaged ${entries.length} entries -> ${relative(root, target)}`);

/**
 * Removes archives from older versions.
 *
 * The release workflow uploads `dist-zip/*.zip`, so anything left in this
 * directory is attached to the release — and v1.6.0 went out carrying a 1.5.0
 * archive beside it, because nothing had ever removed the previous one. Two
 * downloads on a release page, one of them the version the release is not: a
 * person picking the wrong one gets a build without the current fixes and no
 * indication anything is wrong.
 *
 * The directory is committed too, so this also stops it growing by a version
 * every release.
 */
for (const name of readdirSync(outDir)) {
  if (!name.endsWith('.zip')) continue;
  if (name === `universal-bhunex-converter-${version}.zip`) continue;
  rmSync(resolve(outDir, name));
  console.log(`removed a stale archive from a previous version: ${name}`);
}
