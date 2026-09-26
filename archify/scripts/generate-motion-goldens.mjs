import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compile } from '../renderers/shared/motion-runtime.mjs';
import { interpretSequenceMotion, renderSequenceMotionCheckpoint } from '../renderers/sequence/sequence-motion-interpreter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'test/golden/motion/async-job-roundtrip');
const chrome = process.env.ARCHIFY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const sequence = readJson('examples/async-job-roundtrip.sequence.json');
const contract = readJson('examples/motion/async-job-roundtrip.motion.json');
const timeline = compile(contract, sequence);
const checkpoints = [
  ['request', 250],
  ['queued', 750],
  ['processing', 2250],
  ['callback', 4750],
  ['reconciled', 6750],
];

if (!fs.existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}; set ARCHIFY_CHROME`);
fs.mkdirSync(output, { recursive: true });
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-motion-'));
const captures = [];
try {
  for (const [name, timeMs] of checkpoints) {
    const state = timeline.seek(timeMs);
    const frame = interpretSequenceMotion(sequence, state);
    const html = renderSequenceMotionCheckpoint(sequence, frame);
    const htmlPath = path.join(temporary, `${name}.html`);
    const pngPath = path.join(output, `${name}.png`);
    fs.writeFileSync(htmlPath, html);
    const result = spawnSync(chrome, [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
      '--font-render-hinting=none',
      `--window-size=${frame.width},${frame.height}`,
      `--screenshot=${pngPath}`,
      `file://${htmlPath}`,
    ], { encoding: 'utf8', timeout: 30000 });
    if (result.status !== 0) throw new Error(result.stderr || `Chrome exited ${result.status}`);
    const png = fs.readFileSync(pngPath);
    captures.push({
      name,
      timeMs,
      file: `${name}.png`,
      width: png.readUInt32BE(16),
      height: png.readUInt32BE(20),
      pngSha256: sha256(png),
      activeBeatIds: state.activeBeatIds,
      activeNodeIds: state.activeNodeIds,
      activeRelationshipIds: state.activeRelationshipIds,
      states: state.states,
    });
  }
  const receipt = {
    schema: 'archify.motion-golden.v1',
    source: 'examples/async-job-roundtrip.sequence.json',
    contract: 'examples/motion/async-job-roundtrip.motion.json',
    contractSha256: timeline.receipt.contractSha256,
    irSemanticSha256: timeline.receipt.irSemanticSha256,
    captures,
  };
  fs.writeFileSync(path.join(output, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`${output}\n`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
