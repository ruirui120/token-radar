// Rebuild the dossier from an output dir with the vendored library and
// compare it byte for byte with the dossier.json main.ts wrote.
// Usage: node gate_check_dossier.mjs <output-dir>
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { buildDossier } from './vendor/makefun-board.ts';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: node gate_check_dossier.mjs <output-dir>\n');
  process.exit(2);
}
const rebuilt = buildDossier(dir, {
  text_max_bytes: 65536,
  screenshots: { max: 4, max_bytes: 524288 },
  dashboard: { max_files: 400, max_bytes: 4194304 },
});
const written = readFileSync(`${dir}/dossier.json`);
const same = Buffer.compare(Buffer.from(rebuilt), written) === 0;
const sha = (b) => createHash('sha256').update(b).digest('hex').slice(0, 16);
console.log(`${same ? 'PASS' : 'FAIL'} dossier_matches: rebuilt ${rebuilt.length} bytes sha ${sha(rebuilt)}, written ${written.length} bytes sha ${sha(written)}`);
const doc = JSON.parse(Buffer.from(rebuilt).toString('utf8'));
console.log(`INFO dossier: ${doc.images.length} images, text ${Buffer.byteLength(doc.text, 'utf8')} bytes, cover ${doc.images[0]?.name}`);
process.exit(same ? 0 : 1);
