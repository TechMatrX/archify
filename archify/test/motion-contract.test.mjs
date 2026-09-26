import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile, compileMotion, MotionContractError } from '../renderers/shared/motion-runtime.mjs';
import { interpretSequenceMotion, renderSequenceMotionCheckpoint } from '../renderers/sequence/sequence-motion-interpreter.mjs';
import { interpretWorkflowMotion, renderWorkflowMotionCheckpoint } from '../renderers/workflow/workflow-motion-interpreter.mjs';
import { interpretLifecycleMotion, renderLifecycleMotionCheckpoint } from '../renderers/lifecycle/lifecycle-motion-interpreter.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const source = () => readJson('examples/async-job-roundtrip.sequence.json');
const contract = () => readJson('examples/motion/async-job-roundtrip.motion.json');
const architectureSource = () => readJson('examples/production-deployment.architecture.json');
const architectureContract = () => readJson('examples/motion/production-deployment.motion.json');
const workflowSource = () => readJson('examples/release-delivery.workflow.json');
const workflowContract = () => readJson('examples/motion/release-delivery.motion.json');
const lifecycleSource = () => readJson('examples/deployment-release.lifecycle.json');
const lifecycleContract = () => readJson('examples/motion/deployment-release.motion.json');

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
  assert.equal(transit.paused, false);
  assert.deepEqual(timeline.inspect(), transit);
  assert.deepEqual(timeline.inspectMotionState(), transit);
  assert.deepEqual(timeline.seek(4750), transit);
});

test('Sequence interpreter materializes an exact native in-transit frame', () => {
  const timeline = compile(contract(), source());
  const frame = interpretSequenceMotion(source(), timeline.seek(4750));
  assert.deepEqual(frame.activeRelationshipIds, ['deliver-webhook']);
  assert.deepEqual(frame.transits, [{
    id: 'deliver-webhook',
    beatId: 'callback',
    primitive: 'callback',
    from: 'notify',
    to: 'client',
    label: 'signed webhook',
    progress: 0.5,
    x: 386,
    y: 608,
    startX: 703,
    endX: 69,
  }]);
  const checkpoint = renderSequenceMotionCheckpoint(source(), frame);
  assert.match(checkpoint, /data-motion-time-ms="4750"/);
  assert.match(checkpoint, /data-motion-relationship="deliver-webhook" data-active="true"/);
  assert.match(checkpoint, /data-motion-transit="deliver-webhook"/);
  assert.doesNotMatch(checkpoint, /setTimeout|requestAnimationFrame|Date\.now/);
  assert.equal(renderSequenceMotionCheckpoint(source(), frame), checkpoint);
});

test('checked-in Sequence transit PNGs match their immutable motion receipt', () => {
  const receipt = readJson('test/golden/motion/async-job-roundtrip/receipt.json');
  const timeline = compile(contract(), source());
  assert.equal(receipt.contractSha256, timeline.receipt.contractSha256);
  assert.equal(receipt.irSemanticSha256, timeline.receipt.irSemanticSha256);
  assert.deepEqual(receipt.captures.map(({ name }) => name), ['request', 'queued', 'processing', 'callback', 'reconciled']);
  for (const capture of receipt.captures) {
    const png = fs.readFileSync(path.join(root, 'test/golden/motion/async-job-roundtrip', capture.file));
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16), capture.width);
    assert.equal(png.readUInt32BE(20), capture.height);
    assert.equal(crypto.createHash('sha256').update(png).digest('hex'), capture.pngSha256);
    const state = timeline.seek(capture.timeMs);
    assert.deepEqual(state.activeBeatIds, capture.activeBeatIds);
    assert.deepEqual(state.activeNodeIds, capture.activeNodeIds);
    assert.deepEqual(state.activeRelationshipIds, capture.activeRelationshipIds);
    assert.deepEqual(state.states, capture.states);
  }
});

test('pause freezes the inspected deterministic motion state', () => {
  const timeline = compile(contract(), source());
  timeline.seek(4750);
  const paused = timeline.pause();
  assert.equal(paused.paused, true);
  assert.deepEqual(timeline.inspectMotionState(), paused);
  assert.deepEqual(timeline.inspect(), paused);
  assert.deepEqual(timeline.pause(), paused);
});

test('Workflow interpreter follows exact compiled Release Delivery geometry', () => {
  const timeline = compile(workflowContract(), workflowSource());
  assert.equal(timeline.receipt.diagramType, 'workflow');
  assert.equal(timeline.receipt.beatCount, 10);
  assert.equal(timeline.receipt.assertionCount, 5);
  assert.equal(timeline.durationMs, 5000);
  const frame = interpretWorkflowMotion(workflowSource(), timeline.seek(4250));
  assert.deepEqual(frame.activeRelationshipIds, ['verify-rollback']);
  assert.deepEqual(frame.transits, [{
    id: 'verify-rollback',
    beatId: 'trigger-rollback',
    primitive: 'retry',
    from: 'verify_prod',
    to: 'rollback',
    progress: 0.5,
    point: { x: 692, y: 684.5 },
    points: [
      { x: 671, y: 491 },
      { x: 692, y: 491 },
      { x: 692, y: 739 },
      { x: 532, y: 739 },
    ],
  }]);
  const checkpoint = renderWorkflowMotionCheckpoint(workflowSource(), frame);
  assert.match(checkpoint, /data-motion-time-ms="4250"/);
  assert.match(checkpoint, /data-motion-relationship="verify-rollback" data-motion-active="true"/);
  assert.match(checkpoint, /data-motion-node="rollback" data-motion-active="true"/);
  assert.match(checkpoint, /data-motion-transit="verify-rollback"/);
  assert.doesNotMatch(checkpoint, /setTimeout|requestAnimationFrame|Date\.now/);
  assert.equal(renderWorkflowMotionCheckpoint(workflowSource(), frame), checkpoint);
});

test('Workflow motion stays deterministic across authored edge order', () => {
  const first = compile(workflowContract(), workflowSource());
  const reordered = workflowSource();
  reordered.edges.reverse();
  const second = compile(workflowContract(), reordered);
  assert.deepEqual(second.receipt, first.receipt);
  assert.deepEqual(second.seek(4750), first.seek(4750));
  const restored = interpretWorkflowMotion(reordered, second.seek(4750));
  assert.deepEqual(restored.transits[0].point, { x: 426, y: 622 });
  assert.deepEqual(restored.activeNodeIds, ['deploy', 'rollback']);
  assert.deepEqual(restored.states, ['release.restored']);
});

test('Lifecycle interpreter materializes exact Deployment Release transitions', () => {
  const timeline = compile(lifecycleContract(), lifecycleSource());
  assert.equal(timeline.receipt.diagramType, 'lifecycle');
  assert.equal(timeline.receipt.beatCount, 11);
  assert.equal(timeline.receipt.assertionCount, 6);
  assert.equal(timeline.durationMs, 5000);
  const frame = interpretLifecycleMotion(lifecycleSource(), timeline.seek(4750));
  assert.deepEqual(frame.activeRelationshipIds, ['paused-rolled-back']);
  assert.deepEqual(frame.activeNodeIds, ['paused', 'rolled_back']);
  assert.deepEqual(frame.states, ['release.restored']);
  assert.deepEqual(frame.transits, [{
    id: 'paused-rolled-back',
    beatId: 'restore-service',
    primitive: 'retry',
    from: 'paused',
    to: 'rolled_back',
    progress: 0.5,
    point: { x: 710, y: 393 },
    points: [{ x: 710, y: 336 }, { x: 710, y: 450 }],
  }]);
  const checkpoint = renderLifecycleMotionCheckpoint(lifecycleSource(), frame);
  assert.match(checkpoint, /data-motion-time-ms="4750"/);
  assert.match(checkpoint, /data-motion-relationship="paused-rolled-back" data-motion-active="true"/);
  assert.match(checkpoint, /data-motion-node="rolled_back" data-motion-active="true"/);
  assert.match(checkpoint, /data-motion-transit="paused-rolled-back"/);
  assert.doesNotMatch(checkpoint, /setTimeout|requestAnimationFrame|Date\.now/);
  assert.equal(renderLifecycleMotionCheckpoint(lifecycleSource(), frame), checkpoint);
});

test('Lifecycle terminal branches are exclusive and deterministic across transition order', () => {
  const first = compile(lifecycleContract(), lifecycleSource());
  const reordered = lifecycleSource();
  reordered.transitions.reverse();
  const second = compile(lifecycleContract(), reordered);
  assert.deepEqual(second.receipt, first.receipt);
  assert.deepEqual(second.seek(3350), first.seek(3350));
  assert.deepEqual(first.seek(3350).states, ['release.failed']);
  assert.deepEqual(first.seek(4750).states, ['release.restored']);
  assert.notDeepEqual(first.seek(3350).activeNodeIds, first.seek(4750).activeNodeIds);
  assert.deepEqual(interpretLifecycleMotion(reordered, second.seek(4250)).transits[0].point, { x: 710, y: 233 });
});

test('Production Deployment Ownership proves the Architecture Phase 1 anchor', () => {
  const first = compile(architectureContract(), architectureSource());
  const reordered = architectureSource();
  reordered.connections.reverse();
  const second = compile(architectureContract(), reordered);
  assert.equal(first.receipt.diagramType, 'architecture');
  assert.equal(first.receipt.beatCount, 8);
  assert.equal(first.receipt.assertionCount, 8);
  assert.equal(first.durationMs, 4000);
  assert.deepEqual(second.receipt, first.receipt);
  assert.deepEqual(first.seek(3750), {
    timeMs: 3750,
    durationMs: 4000,
    paused: false,
    activeBeatIds: ['emit-evidence'],
    activeNodeIds: ['audit', 'observability', 'worker'],
    activeRelationshipIds: ['worker-audit-evidence', 'worker-observability-otlp'],
    states: ['evidence.emitted'],
    relationships: [
      { id: 'worker-audit-evidence', beatId: 'emit-evidence', primitive: 'fanout', progress: 0.5 },
      { id: 'worker-observability-otlp', beatId: 'emit-evidence', primitive: 'fanout', progress: 0.5 },
    ],
  });
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
