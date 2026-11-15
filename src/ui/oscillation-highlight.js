// Presentation-only diagnostics. Cached legacy recovery never replaces runtime
// state, advances the active simulation, or changes its budgets/statistics.
import { evaluateDynamic } from '../core/dynamic.js';
import { componentBounds } from '../core/geometry.js';
import { buildNets } from '../core/nets.js';

const recovered = new WeakMap();
const mapped = new WeakMap();

function legacyDiagnostic(state, evaluation, definitions) {
  const cached = recovered.get(evaluation);
  if (cached && cached.definitions === definitions) return cached.diagnostic;
  // Preserve draft IN values, including inputs bound to otherwise bare pins.
  const externalInputs = [];
  for (const [key, driver] of Object.entries(evaluation.inputDrivers || {})) {
    if (typeof driver !== 'string' || !driver.startsWith('external:')) continue;
    const split = key.lastIndexOf(':');
    externalInputs.push({
      portId: driver.slice('external:'.length),
      binding: { kind: 'pin', componentId: key.slice(0, split), pinId: key.slice(split + 1) },
      value: evaluation.pinValue[key]
    });
  }
  const result = evaluateDynamic(state, evaluation, undefined, {
    definitions, includeBarePins: true, externalInputs
  });
  const diagnostic = result.ok && result.status === 'oscillating' ? result.oscillation : null;
  recovered.set(evaluation, { definitions, diagnostic });
  return diagnostic;
}

export function getOscillationHighlight(state, evaluation, definitions) {
  if (!evaluation || evaluation.status !== 'oscillating') return null;
  let byState = mapped.get(evaluation);
  if (!byState) {
    byState = new WeakMap();
    mapped.set(evaluation, byState);
  }
  const cached = byState.get(state);
  if (cached && cached.definitions === definitions) return cached.highlight;
  const diagnostic = evaluation.oscillation || legacyDiagnostic(state, evaluation, definitions);
  let highlight = null;
  if (diagnostic && Array.isArray(diagnostic.componentIds) && Array.isArray(diagnostic.netIds)) {
    const componentIds = [...new Set(diagnostic.componentIds.filter(id => state.components[id]))].sort();
    const netIds = [...new Set(diagnostic.netIds)].sort();
    const wanted = new Set(netIds);
    const wireIds = wanted.size ? buildNets(state, { definitions }).nets
      .filter(net => wanted.has(net.id)).flatMap(net => net.wireIds).sort() : [];
    if (componentIds.length || wireIds.length) highlight = { componentIds, netIds, wireIds };
  }
  byState.set(state, { definitions, highlight });
  return highlight;
}

// Keep the dark-red phase visible, with enough contrast against bright red
// for the 1s pulse to be obvious without a fast on/off flash.
export function oscillationPulse(timeMs, reducedMotion) {
  const phase = reducedMotion ? 1 : (1 - Math.cos((Number.isFinite(timeMs) ? timeMs : 0) * Math.PI / 500)) / 2;
  return {
    color: 'rgb(' + Math.round(105 + 150 * phase) + ', ' + Math.round(20 + 65 * phase) + ', ' + Math.round(25 + 70 * phase) + ')',
    width: 3.5
  };
}

export function hasVisibleOscillationHighlight(state, view, width, height, highlight, definitions) {
  if (!highlight) return false;
  const margin = 10;
  function intersects(x, y, w, h) {
    const sx = x * view.scale + view.pan.x;
    const sy = y * view.scale + view.pan.y;
    return sx + w * view.scale >= -margin && sy + h * view.scale >= -margin &&
      sx <= width + margin && sy <= height + margin;
  }
  for (const id of highlight.componentIds) {
    const bounds = componentBounds(state.components[id], definitions);
    if (bounds && intersects(bounds.x, bounds.y, bounds.w, bounds.h)) return true;
  }
  for (const id of highlight.wireIds) {
    const points = state.wires[id] && state.wires[id].points || [];
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1], b = points[index];
      if (intersects(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(a.x - b.x), Math.abs(a.y - b.y))) return true;
    }
  }
  return false;
}
