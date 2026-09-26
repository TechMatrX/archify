import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile, compileMotion, MotionContractError } from '../renderers/shared/motion-runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const source = () => readJson('examples/async-job-roundtrip.sequence.json');
const contract = () => readJson('examples/motion/async-job-roundtrip.motion.json');

test('archify.motion.v1 compiles the Async Job Roundtrip golden against authored ids', () => {
  assert.equal(compileMotion, compile);
  const timeline = compile(contract(), source());
  assert.equal(timeline.receipt.motionVersion, 'archify.motion.v1');
  assert.equal(timeline.receipt.diagramType, 'sequence');
  assert.equal(timeline.receipt.beatCount, 14);
  assert.equal(timeline.receipt.assertionCount, 5);
  assert.equal(timeline.durationMs, 7000);
  assert.match(timeline.receipt.contractSha256, /^[a-f0-9]{64}$/);
  assert.match(timeline.receipt.irSemanticSha256, /^[a-f0-9]{64}$/);
});

test('seek and inspect expose deterministic in-transit semantic state', () => {
  const timeline = compileMotion(contract(), source());
  const transit = timeline.seek(4750);
  assert.deepEqual(transit.activeBeatIds, ['callback']);
  assert.deepEqual(transit.activeNodeIds, ['client', 'notify']);
  assert.deepEqual(transit.activeRelationshipIds, ['deliver-webhook']);
  assert.deepEqual(transit.states, ['notification.delivered']);
  assert.deepEqual(transit.relationships, [{
    id: 'deliver-webhook',
    beatId: 'callback',
    primitive: 'callback',
    progress: 0.5,
  }]);
  assert.deepEqual(timeline.inspect(), transit);
  assert.deepEqual(timeline.seek(4750), transit);
});

test('motion compilation is byte-deterministic across relationship source order', () => {
  const first = compileMotion(contract(), source());
  const reordered = source();
  reordered.messages.reverse();
  const second = compileMotion(contract(), reordered);
  assert.deepEqual(second.receipt, first.receipt);
  assert.deepEqual(second.seek(6750), first.seek(6750));
});

test('motion compilation rejects unresolved authored relationship ids', () => {
  const invalid = contract();
  invalid.beats[0].targets.relationships = ['not-authored'];
  assert.throws(
    () => compileMotion(invalid, source()),
    (error) => error instanceof MotionContractError
      && error.diagnostics[0].rule === 'unresolved-relationship-id'
      && error.diagnostics[0].path === '/beats/0/targets/relationships',
  );
});

test('motion compilation rejects assertion drift before playback', () => {
  const invalid = contract();
  invalid.assertions[0].activeNodes = ['queue'];
  assert.throws(
    () => compileMotion(invalid, source()),
    (error) => error instanceof MotionContractError
      && error.diagnostics[0].rule === 'assertion-mismatch'
      && error.diagnostics[0].path === '/assertions/0/activeNodes',
  );
});

test('motion schema rejects arbitrary visual coordinates', () => {
  const invalid = contract();
  invalid.beats[0].x = 10;
  assert.throws(
    () => compileMotion(invalid, source()),
    (error) => error instanceof MotionContractError
      && error.diagnostics.some((diagnostic) => diagnostic.rule === 'schema.additionalProperties'),
  );
});
