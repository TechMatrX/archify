import { MotionContractError } from '../shared/motion-runtime.mjs';

const LAYOUT = Object.freeze({
  phaseY: 126,
  eventY: 278,
  outcomeY: 450,
  phaseW: 118,
  phaseH: 62,
  eventW: 126,
  eventH: 58,
  outcomeW: 118,
  outcomeH: 58,
  phaseXs: Object.freeze([94, 248, 402, 556, 710]),
  eventXs: Object.freeze([402, 556, 710]),
  outcomeXs: Object.freeze([402, 556, 710]),
});

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

function bandFor(lane) {
  if (lane === 'main') return 'phase';
  if (lane === 'terminal') return 'outcome';
  return 'event';
}

function measureState(state) {
  const band = bandFor(state.lane);
  const width = state.width || (band === 'phase' ? LAYOUT.phaseW : band === 'outcome' ? LAYOUT.outcomeW : LAYOUT.eventW);
  const height = state.height || (band === 'phase' ? LAYOUT.phaseH : band === 'outcome' ? LAYOUT.outcomeH : LAYOUT.eventH);
  const xs = band === 'phase' ? LAYOUT.phaseXs : band === 'outcome' ? LAYOUT.outcomeXs : LAYOUT.eventXs;
  const cx = xs[state.col] ?? xs.at(-1);
  const y = (band === 'phase' ? LAYOUT.phaseY : band === 'outcome' ? LAYOUT.outcomeY : LAYOUT.eventY) + (state.yOffset || 0);
  return Object.freeze({ ...state, x: cx - width / 2, y, width, height, cx, cy: y + height / 2 });
}

function anchor(state, side) {
  if (side === 'top') return Object.freeze({ x: state.cx, y: state.y });
  if (side === 'bottom') return Object.freeze({ x: state.cx, y: state.y + state.height });
  if (side === 'left') return Object.freeze({ x: state.x, y: state.cy });
  return Object.freeze({ x: state.x + state.width, y: state.cy });
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

function compileGeometry(lifecycle) {
  const states = new Map((lifecycle.states || []).map((state) => [state.id, measureState(state)]));
  const transitions = new Map();
  for (const transition of lifecycle.transitions || []) {
    if (!transition.id) continue;
    const from = states.get(transition.from);
    const to = states.get(transition.to);
    if (!from || !to) fail('lifecycle-interpreter-node', `Lifecycle transition "${transition.id}" has an unknown endpoint`);
    if ((transition.route || 'auto') !== 'straight') {
      fail('lifecycle-interpreter-route', `Lifecycle transition "${transition.id}" requires compiled support for route "${transition.route}"`);
    }
    const points = Object.freeze([
      anchor(from, transition.fromSide || 'bottom'),
      anchor(to, transition.toSide || 'top'),
    ]);
    transitions.set(transition.id, Object.freeze({ id: transition.id, from: transition.from, to: transition.to, points }));
  }
  return Object.freeze({ states, transitions });
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
  const viewBox = lifecycle.meta?.viewBox || [980, 660];
  return Object.freeze({
    diagramType: 'lifecycle',
    timeMs: motionState.timeMs,
    durationMs: motionState.durationMs,
    paused: motionState.paused,
    width: viewBox[0],
    height: viewBox[1],
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
  const transitions = (lifecycle.transitions || []).filter((transition) => transition.id).map((transition) => {
    const route = frame.geometry.transitions.get(transition.id);
    const points = route.points.map((point) => `${point.x},${point.y}`).join(' ');
    return `<polyline data-motion-relationship="${esc(transition.id)}" data-motion-active="${activeRelationships.has(transition.id)}" points="${points}" fill="none" stroke="${activeRelationships.has(transition.id) ? '#49d6ff' : '#52657f'}" stroke-width="${activeRelationships.has(transition.id) ? 4 : 1.5}"/>`;
  }).join('');
  const nodes = [...frame.geometry.states.values()].map((state) => {
    const active = activeNodes.has(state.id);
    return `<g data-motion-node="${esc(state.id)}" data-motion-active="${active}"><rect x="${state.x}" y="${state.y}" width="${state.width}" height="${state.height}" rx="7" fill="${active ? '#123d4d' : '#14243a'}" stroke="${active ? '#49d6ff' : '#5b7290'}" stroke-width="${active ? 3 : 1.5}"/><text x="${state.cx}" y="${state.cy + 4}" text-anchor="middle" fill="#f8fafc" font-size="11">${esc(state.label)}</text></g>`;
  }).join('');
  const transits = frame.transits.map((transit) => `<g data-motion-transit="${esc(transit.id)}"><circle cx="${transit.point.x}" cy="${transit.point.y}" r="8" fill="#fff" stroke="#49d6ff" stroke-width="4"/><circle cx="${transit.point.x}" cy="${transit.point.y}" r="15" fill="none" stroke="#49d6ff" stroke-width="3" opacity=".45"/></g>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07111f}svg{display:block;width:${frame.width}px;height:${frame.height}px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${frame.width} ${frame.height}" data-motion-time-ms="${frame.timeMs}" data-motion-paused="${frame.paused}">${transitions}${nodes}${transits}<text x="24" y="${frame.height - 20}" fill="#aebed1" font-size="11">${esc(frame.states.join(' · '))} · ${frame.timeMs}ms</text></svg></body></html>`;
}
