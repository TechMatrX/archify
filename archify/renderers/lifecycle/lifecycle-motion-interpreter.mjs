import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MotionContractError } from '../shared/motion-runtime.mjs';

const renderer = path.join(path.dirname(fileURLToPath(import.meta.url)), 'render-lifecycle.mjs');

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

function attributes(tag) { return Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map((match) => [match[1], match[2]])); }
function parsePoints(value) { return value.split(';').map((point) => point.split(',').map(Number)).map(([x, y]) => Object.freeze({ x, y })); }

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

function compileGeometry(lifecycle) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-lifecycle-motion-'));
  try {
    const source = path.join(temporary, 'source.json');
    const output = path.join(temporary, 'compiled.html');
    fs.writeFileSync(source, `${JSON.stringify(lifecycle)}\n`);
    const result = spawnSync(process.execPath, [renderer, source, output], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ARCHIFY_QUALITY_PROFILE: lifecycle.meta?.quality_profile || 'standard' } });
    if (result.status !== 0 || !fs.existsSync(output)) fail('lifecycle-interpreter-compile', `Lifecycle motion requires valid compiled geometry: ${(result.stderr || result.stdout || `renderer exited ${result.status}`).trim()}`);
    const html = fs.readFileSync(output, 'utf8');
    const svg = /<svg\b[\s\S]*?<\/svg>/.exec(html)?.[0];
    if (!svg) fail('lifecycle-interpreter-compile', 'Lifecycle renderer did not emit native SVG geometry');
    const transitions = new Map();
    for (const match of svg.matchAll(/<path\b[^>]*data-edge-id="[^"]+"[^>]*data-composition-points="[^"]+"[^>]*\/>/g)) {
      const attrs = attributes(match[0]);
      transitions.set(attrs['data-edge-id'], Object.freeze({ id: attrs['data-edge-id'], from: attrs['data-edge-from'], to: attrs['data-edge-to'], points: Object.freeze(parsePoints(attrs['data-composition-points'])) }));
    }
    return Object.freeze({ svg, transitions });
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export function interpretLifecycleMotion(lifecycle, motionState) {
  if (lifecycle?.diagram_type !== 'lifecycle') fail('lifecycle-interpreter-type', 'Lifecycle motion requires Lifecycle IR');
  if (!motionState || typeof motionState !== 'object') fail('lifecycle-interpreter-state', 'Lifecycle motion requires inspected motion state');
  const geometry = compileGeometry(lifecycle);
  const transits = motionState.relationships.map((transit) => {
    const route = geometry.transitions.get(transit.id);
    if (!route) fail('lifecycle-interpreter-relationship', `Unknown compiled Lifecycle relationship "${transit.id}"`);
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
  const viewBox = /<svg\b[^>]*viewBox="([^"]+)"/.exec(geometry.svg)?.[1]?.split(/\s+/).map(Number) || [0, 0, 980, 660];
  return Object.freeze({
    diagramType: 'lifecycle',
    timeMs: motionState.timeMs,
    durationMs: motionState.durationMs,
    paused: motionState.paused,
    width: viewBox[2],
    height: viewBox[3],
    activeNodeIds: Object.freeze([...motionState.activeNodeIds]),
    activeRelationshipIds: Object.freeze([...motionState.activeRelationshipIds]),
    states: Object.freeze([...motionState.states]),
    transits: Object.freeze(transits),
    geometry,
  });
}

export function renderLifecycleMotionCheckpoint(lifecycle, frame) {
  const activeNodes = new Set(frame.activeNodeIds);
  const activeRelationships = new Set(frame.activeRelationshipIds);
  let svg = frame.geometry.svg.replace(/<path\b[^>]*data-edge-id="([^"]+)"[^>]*data-composition-points="[^"]+"[^>]*\/>/g, (tag, id) => tag.replace('<path ', `<path data-motion-relationship="${esc(id)}" data-motion-active="${activeRelationships.has(id)}" `));
  svg = svg.replace(/<g\b[^>]*data-node-id="([^"]+)"[^>]*>/g, (tag, id) => tag.replace('<g ', `<g data-motion-node="${esc(id)}" data-motion-active="${activeNodes.has(id)}" `));
  const transits = frame.transits.map((transit) => `<g data-motion-transit="${esc(transit.id)}"><circle cx="${transit.point.x}" cy="${transit.point.y}" r="8" fill="#fff" stroke="#49d6ff" stroke-width="4"/><circle cx="${transit.point.x}" cy="${transit.point.y}" r="15" fill="none" stroke="#49d6ff" stroke-width="3" opacity=".45"/></g>`).join('');
  svg = svg.replace('</svg>', `${transits}<text x="24" y="${frame.height - 20}" fill="#aebed1" font-size="11">${esc(frame.states.join(' · '))} · ${frame.timeMs}ms</text></svg>`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07111f}svg{display:block;width:${frame.width}px;height:${frame.height}px}</style></head><body data-motion-time-ms="${frame.timeMs}" data-motion-paused="${frame.paused}">${svg}</body></html>`;
}
