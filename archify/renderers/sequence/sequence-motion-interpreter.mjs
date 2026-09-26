import { MotionContractError } from '../shared/motion-runtime.mjs';

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

export function interpretSequenceMotion(sequence, motionState) {
  if (sequence?.diagram_type !== 'sequence') fail('sequence-interpreter-type', 'Sequence motion requires sequence IR');
  if (!motionState || typeof motionState !== 'object') fail('sequence-interpreter-state', 'Sequence motion requires inspected motion state');
  const participants = new Map((sequence.participants || []).map((participant, index) => [participant.id, { ...participant, index }]));
  const messages = new Map((sequence.messages || []).filter((message) => message.id).map((message) => [message.id, message]));
  const width = sequence.meta?.viewBox?.[0] || 920;
  const height = sequence.meta?.viewBox?.[1] || 760;
  const participantWidth = sequence.meta?.column_fit === 'spread'
    ? Math.max(86, Math.min(190, Math.round((width - 124) / Math.max(1, participants.size)) - 24))
    : 86;
  const leftX = sequence.meta?.column_fit === 'spread' ? 62 + participantWidth / 2 : 62;
  const gap = sequence.meta?.column_fit === 'spread' && participants.size > 1
    ? Math.max(108, (width - 40 - 62 - participantWidth) / (participants.size - 1))
    : 108;
  const x = (participantId) => {
    const participant = participants.get(participantId);
    if (!participant) fail('sequence-interpreter-node', `Unknown sequence participant "${participantId}"`);
    return leftX + participant.index * gap;
  };
  const transits = motionState.relationships.map((transit) => {
    const message = messages.get(transit.id);
    if (!message) fail('sequence-interpreter-relationship', `Unknown authored sequence relationship "${transit.id}"`);
    const fromX = x(message.from);
    const toX = x(message.to);
    const direction = toX >= fromX ? 1 : -1;
    const startX = fromX + direction * 7;
    const endX = toX - direction * 7;
    const progress = clamp(transit.progress, 0, 1);
    return Object.freeze({
      id: transit.id,
      beatId: transit.beatId,
      primitive: transit.primitive,
      from: message.from,
      to: message.to,
      label: message.label || transit.id,
      progress,
      x: startX + (endX - startX) * progress,
      y: message.y,
      startX,
      endX,
    });
  });
  return Object.freeze({
    diagramType: 'sequence',
    timeMs: motionState.timeMs,
    durationMs: motionState.durationMs,
    paused: motionState.paused,
    width,
    height,
    activeNodeIds: Object.freeze([...motionState.activeNodeIds]),
    activeRelationshipIds: Object.freeze([...motionState.activeRelationshipIds]),
    states: Object.freeze([...motionState.states]),
    transits: Object.freeze(transits),
  });
}

export function renderSequenceMotionCheckpoint(sequence, frame) {
  const width = frame.width;
  const height = frame.height;
  const participants = sequence.participants || [];
  const participantWidth = sequence.meta?.column_fit === 'spread'
    ? Math.max(86, Math.min(190, Math.round((width - 124) / Math.max(1, participants.length)) - 24))
    : 86;
  const leftX = sequence.meta?.column_fit === 'spread' ? 62 + participantWidth / 2 : 62;
  const gap = sequence.meta?.column_fit === 'spread' && participants.length > 1
    ? Math.max(108, (width - 40 - 62 - participantWidth) / (participants.length - 1))
    : 108;
  const px = new Map(participants.map((participant, index) => [participant.id, leftX + index * gap]));
  const activeNodes = new Set(frame.activeNodeIds);
  const activeRelationships = new Set(frame.activeRelationshipIds);
  const messages = (sequence.messages || []).map((message) => {
    const fromX = px.get(message.from);
    const toX = px.get(message.to);
    const active = activeRelationships.has(message.id);
    return `<g data-motion-relationship="${esc(message.id || '')}" data-active="${active}"><line x1="${fromX}" y1="${message.y}" x2="${toX}" y2="${message.y}" class="message ${active ? 'active' : ''}"/><text x="${(fromX + toX) / 2}" y="${message.y - 8}" text-anchor="middle">${esc(message.label || '')}</text></g>`;
  }).join('');
  const nodes = participants.map((participant, index) => {
    const cx = leftX + index * gap;
    const active = activeNodes.has(participant.id);
    return `<g data-motion-node="${esc(participant.id)}" data-active="${active}"><rect x="${cx - participantWidth / 2}" y="28" width="${participantWidth}" height="54" rx="10" class="node ${active ? 'active' : ''}"/><text x="${cx}" y="60" text-anchor="middle" class="node-label">${esc(participant.label)}</text><line x1="${cx}" y1="82" x2="${cx}" y2="${height - 52}" class="lifeline"/></g>`;
  }).join('');
  const transits = frame.transits.map((transit) => `<g data-motion-transit="${esc(transit.id)}"><circle cx="${transit.x}" cy="${transit.y}" r="8" class="transit"/><circle cx="${transit.x}" cy="${transit.y}" r="15" class="transit-halo"/></g>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#07111f}svg{display:block;width:${width}px;height:${height}px;background:#0b1728;color:#cbd5e1;font:11px ui-monospace,SFMono-Regular,Menlo,monospace}.node{fill:#14243a;stroke:#5b7290;stroke-width:1.5}.node.active{fill:#123d4d;stroke:#49d6ff;stroke-width:3}.node-label{fill:#f8fafc;font-size:12px;font-weight:700}.lifeline{stroke:#334155;stroke-dasharray:4 6}.message{stroke:#52657f;stroke-width:1.5}.message.active{stroke:#49d6ff;stroke-width:4}text{fill:#aebed1}.transit{fill:#fff;stroke:#49d6ff;stroke-width:4}.transit-halo{fill:none;stroke:#49d6ff;stroke-width:3;opacity:.45}</style></head><body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" data-motion-time-ms="${frame.timeMs}" data-motion-paused="${frame.paused}">${nodes}${messages}${transits}<text x="24" y="${height - 20}" class="state">${esc(frame.states.join(' · '))} · ${frame.timeMs}ms</text></svg></body></html>`;
}
