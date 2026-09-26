import crypto from 'node:crypto';
import { motion as validateMotion } from './generated-validators.mjs';

const COLLECTIONS = Object.freeze({
  architecture: { nodes: 'components', relationships: 'connections' },
  workflow: { nodes: 'nodes', relationships: 'edges' },
  sequence: { nodes: 'participants', relationships: 'messages' },
  dataflow: { nodes: 'nodes', relationships: 'flows' },
  lifecycle: { nodes: 'states', relationships: 'transitions' },
});

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function equalSet(actual, expected) {
  return JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));
}

export class MotionContractError extends Error {
  constructor(message, diagnostics) {
    super(message);
    this.name = 'MotionContractError';
    this.diagnostics = diagnostics;
  }
}

function fail(rule, message, path = '') {
  throw new MotionContractError(message, [{ rule, path, message }]);
}

function indexed(items, subject, collection) {
  const map = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item?.id) continue;
    if (map.has(item.id)) fail('duplicate-semantic-id', `duplicate ${subject} id "${item.id}"`, `/${collection}/${index}/id`);
    map.set(item.id, item);
  }
  return map;
}

function createInspector(beats, durationMs) {
  let timeMs = 0;
  let paused = false;
  const inspectAt = (requestedMs, isPaused = paused) => {
    const boundedMs = Math.max(0, Math.min(durationMs, requestedMs));
    const active = beats.filter((beat) => boundedMs >= beat.startMs && boundedMs < beat.endMs);
    return Object.freeze({
      timeMs: boundedMs,
      durationMs,
      paused: isPaused,
      activeBeatIds: active.map((beat) => beat.id),
      activeNodeIds: sorted(active.flatMap((beat) => beat.targets.nodes)),
      activeRelationshipIds: sorted(active.flatMap((beat) => beat.targets.relationships)),
      states: sorted(active.map((beat) => beat.state)),
      relationships: active.flatMap((beat) => beat.targets.relationships.map((id) => Object.freeze({
        id,
        beatId: beat.id,
        primitive: beat.primitive,
        progress: Math.max(0, Math.min(1, (boundedMs - beat.startMs) / beat.durationMs)),
      }))),
    });
  };
  return {
    seek(requestedMs) {
      if (!Number.isFinite(requestedMs)) fail('invalid-seek', 'seek time must be finite');
      timeMs = Math.max(0, Math.min(durationMs, requestedMs));
      return inspectAt(timeMs);
    },
    pause() {
      paused = true;
      return inspectAt(timeMs);
    },
    inspectMotionState() {
      return inspectAt(timeMs);
    },
    inspect() {
      return inspectAt(timeMs);
    },
    inspectAt(requestedMs) {
      return inspectAt(requestedMs, false);
    },
  };
}

export function compile(contract, ir) {
  if (!validateMotion(contract)) {
    throw new MotionContractError('motion contract schema validation failed', validateMotion.errors.map((error) => ({
      rule: `schema.${error.keyword}`,
      path: error.instancePath,
      message: error.message,
    })));
  }
  if (!ir || typeof ir !== 'object' || Array.isArray(ir)) fail('invalid-ir', 'Archify IR must be an object');
  if (ir.diagram_type !== contract.diagram_type) {
    fail('diagram-type-mismatch', `motion contract targets ${contract.diagram_type}, received ${ir.diagram_type ?? 'unknown'}`, '/diagram_type');
  }
  const collections = COLLECTIONS[contract.diagram_type];
  const nodes = indexed(Array.isArray(ir[collections.nodes]) ? ir[collections.nodes] : [], 'node', collections.nodes);
  const relationships = indexed(Array.isArray(ir[collections.relationships]) ? ir[collections.relationships] : [], 'relationship', collections.relationships);
  const beatIds = new Set();
  const beats = contract.beats.map((beat, beatIndex) => {
    if (beatIds.has(beat.id)) fail('duplicate-beat-id', `duplicate beat id "${beat.id}"`, `/beats/${beatIndex}/id`);
    beatIds.add(beat.id);
    for (const nodeId of beat.targets.nodes) {
      if (!nodes.has(nodeId)) fail('unresolved-node-id', `beat "${beat.id}" references unknown node "${nodeId}"`, `/beats/${beatIndex}/targets/nodes`);
    }
    for (const relationshipId of beat.targets.relationships) {
      if (!relationships.has(relationshipId)) {
        fail('unresolved-relationship-id', `beat "${beat.id}" references unknown authored relationship "${relationshipId}"`, `/beats/${beatIndex}/targets/relationships`);
      }
    }
    return Object.freeze({ ...beat, targets: Object.freeze({
      nodes: Object.freeze([...beat.targets.nodes]),
      relationships: Object.freeze([...beat.targets.relationships]),
    }), endMs: beat.startMs + beat.durationMs });
  });
  const durationMs = Math.max(...beats.map((beat) => beat.endMs));
  const inspector = createInspector(beats, durationMs);
  const assertionIds = new Set();
  for (let index = 0; index < contract.assertions.length; index += 1) {
    const assertion = contract.assertions[index];
    if (assertionIds.has(assertion.id)) fail('duplicate-assertion-id', `duplicate assertion id "${assertion.id}"`, `/assertions/${index}/id`);
    assertionIds.add(assertion.id);
    const snapshot = inspector.inspectAt(assertion.atMs);
    const checks = [
      ['activeBeats', snapshot.activeBeatIds, assertion.activeBeats],
      ['activeNodes', snapshot.activeNodeIds, assertion.activeNodes],
      ['activeRelationships', snapshot.activeRelationshipIds, assertion.activeRelationships],
      ['states', snapshot.states, assertion.states],
    ];
    for (const [field, actual, expected] of checks) {
      if (!equalSet(actual, expected)) {
        fail('assertion-mismatch', `assertion "${assertion.id}" ${field} expected ${JSON.stringify(sorted(expected))}, received ${JSON.stringify(sorted(actual))}`, `/assertions/${index}/${field}`);
      }
    }
  }
  const receipt = Object.freeze({
    motionVersion: contract.motion_version,
    diagramType: contract.diagram_type,
    durationMs,
    beatCount: beats.length,
    assertionCount: contract.assertions.length,
    contractSha256: digest(contract),
    irSemanticSha256: digest({
      diagram_type: ir.diagram_type,
      nodes: [...nodes.keys()].sort(),
      relationships: [...relationships.values()].map(({ id, from, to }) => ({ id, from, to })).sort((a, b) => a.id.localeCompare(b.id)),
    }),
  });
  return Object.freeze({
    beats: Object.freeze(beats),
    durationMs,
    receipt,
    seek: inspector.seek,
    pause: inspector.pause,
    inspectMotionState: inspector.inspectMotionState,
    inspect: inspector.inspect,
  });
}

export const compileMotion = compile;
