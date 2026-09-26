import { MotionContractError } from '../shared/motion-runtime.mjs';
import { compileWorkflow } from './workflow-compiler.mjs';

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function esc(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function fail(rule, message) {
  throw new MotionContractError(message, [{ rule, path: '', message }]);
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]));
}

function parsePoints(value) {
  return value.split(';').map((point) => point.split(',').map(Number)).map(([x, y]) => ({ x, y }));
}

function pointOnPolyline(points, progress) {
  const segments = points.slice(1).map((point, index) => ({
    from: points[index],
    to: point,
    length: Math.hypot(point.x - points[index].x, point.y - points[index].y),
  }));
  const total = segments.reduce((sum, segment) => sum + segment.length, 0);
  let remaining = clamp(progress, 0, 1) * total;
  for (const segment of segments) {
    if (remaining <= segment.length || segment === segments.at(-1)) {
      const ratio = segment.length === 0 ? 1 : remaining / segment.length;
      return Object.freeze({
        x: segment.from.x + (segment.to.x - segment.from.x) * ratio,
        y: segment.from.y + (segment.to.y - segment.from.y) * ratio,
      });
    }
    remaining -= segment.length;
  }
  return Object.freeze({ ...points.at(-1) });
}

function compileGeometry(workflow) {
  const compiled = compileWorkflow({ workflow, qualityProfile: workflow.meta?.quality_profile });
  if (!compiled.ok) fail('workflow-interpreter-compile', 'Workflow motion requires valid compiled Workflow geometry');
  const edgeByEndpoints = new Map((workflow.edges || []).map((edge) => [`${edge.from}\u0000${edge.to}`, edge]));
  const geometry = new Map();
  for (const match of compiled.svg.matchAll(/<path\b[^>]*data-composition-points="[^"]+"[^>]*\/>/g)) {
    const attrs = attributes(match[0]);
    const edge = edgeByEndpoints.get(`${attrs['data-edge-from']}\u0000${attrs['data-edge-to']}`);
    if (!edge?.id) continue;
    geometry.set(edge.id, Object.freeze({
      id: edge.id,
      from: edge.from,
      to: edge.to,
      points: Object.freeze(parsePoints(attrs['data-composition-points']).map(Object.freeze)),
    }));
  }
  return Object.freeze({ svg: compiled.svg, geometry });
}

export function interpretWorkflowMotion(workflow, motionState) {
  if (workflow?.diagram_type !== 'workflow') fail('workflow-interpreter-type', 'Workflow motion requires Workflow IR');
  if (!motionState || typeof motionState !== 'object') fail('workflow-interpreter-state', 'Workflow motion requires inspected motion state');
  const { svg, geometry } = compileGeometry(workflow);
  const transits = motionState.relationships.map((transit) => {
    const route = geometry.get(transit.id);
    if (!route) fail('workflow-interpreter-relationship', `Unknown compiled Workflow relationship "${transit.id}"`);
    const progress = clamp(transit.progress, 0, 1);
    return Object.freeze({
      id: transit.id,
      beatId: transit.beatId,
      primitive: transit.primitive,
      from: route.from,
      to: route.to,
      progress,
      point: pointOnPolyline(route.points, progress),
      points: route.points,
    });
  });
  const viewBox = /<svg\b[^>]*viewBox="([^"]+)"/.exec(svg)?.[1]?.split(/\s+/).map(Number) || [0, 0, 720, 900];
  return Object.freeze({
    diagramType: 'workflow',
    timeMs: motionState.timeMs,
    durationMs: motionState.durationMs,
    paused: motionState.paused,
    width: viewBox[2],
    height: viewBox[3],
    activeNodeIds: Object.freeze([...motionState.activeNodeIds]),
    activeRelationshipIds: Object.freeze([...motionState.activeRelationshipIds]),
    states: Object.freeze([...motionState.states]),
    transits: Object.freeze(transits),
    svg,
  });
}

export function renderWorkflowMotionCheckpoint(workflow, frame) {
  const edges = new Map((workflow.edges || []).filter((edge) => edge.id).map((edge) => [`${edge.from}\u0000${edge.to}`, edge.id]));
  const activeNodes = new Set(frame.activeNodeIds);
  const activeRelationships = new Set(frame.activeRelationshipIds);
  let svg = frame.svg.replace(/<path\b[^>]*data-composition-points="[^"]+"[^>]*\/>/g, (tag) => {
    const attrs = attributes(tag);
    const id = edges.get(`${attrs['data-edge-from']}\u0000${attrs['data-edge-to']}`);
    if (!id) return tag;
    return tag.replace('<path ', `<path data-motion-relationship="${esc(id)}" data-motion-active="${activeRelationships.has(id)}" `);
  });
  svg = svg.replace(/<g\b[^>]*data-node-id="([^"]+)"[^>]*>/g, (tag, id) => tag.replace('<g ', `<g data-motion-node="${esc(id)}" data-motion-active="${activeNodes.has(id)}" `));
  const overlay = frame.transits.map((transit) => `<g data-motion-transit="${esc(transit.id)}"><circle cx="${transit.point.x}" cy="${transit.point.y}" r="8" fill="#fff" stroke="#49d6ff" stroke-width="4"/><circle cx="${transit.point.x}" cy="${transit.point.y}" r="15" fill="none" stroke="#49d6ff" stroke-width="3" opacity=".45"/></g>`).join('');
  svg = svg.replace('</svg>', `${overlay}<text x="24" y="${frame.height - 20}" fill="#aebed1" font-size="11">${esc(frame.states.join(' · '))} · ${frame.timeMs}ms</text></svg>`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07111f}svg{display:block;width:${frame.width}px;height:${frame.height}px}</style></head><body><div data-motion-time-ms="${frame.timeMs}" data-motion-paused="${frame.paused}">${svg}</div></body></html>`;
}
