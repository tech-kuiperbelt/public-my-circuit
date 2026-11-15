import { netConnectionSignature } from './topology-signature.js';
// Breadth-first digital simulation. All pending components read one boundary
// snapshot, then commit together; static fixed-point analysis never participates.
//
// CUSTOM instances are atomic outer components: one frontier entry counts as
// one gate evaluation, while their internal circuit runs through the same
// evaluateDynamic loop with its own independent budgets and inherited history.
import { COMPONENT_PINS, componentPins } from './geometry.js';
import { buildNets } from './nets.js';
import {
  bindingNetId,
  definitionBuilt,
  externalInputsForInstance,
  getDefinition,
  inputPorts,
  outputPorts,
  portValue
} from './ports.js';

export const DEFAULT_DYNAMIC_LIMITS = Object.freeze({
  gateEvalBudget: 200000,
  roundBudget: 10000,
  historyBudget: 8 * 1024 * 1024
});
const GATES = new Set(['NOT', 'AND', 'OR', 'DELAY']);
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const bit = value => value === 1 ? 1 : 0;

function isCustom(component) {
  return Boolean(component && component.type === 'CUSTOM');
}

function isGate(component) {
  return Boolean(component) && (GATES.has(component.type) || isCustom(component));
}

function clone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function compactFailure(result) {
  if (!result) {
    return null;
  }
  // A runtime failure is a frozen diagnostic boundary, distinct from the
  // instance's last committed `internal` state. Keep its full attempted
  // evaluation so the UI can inspect each real layer without replaying it.
  // The evaluation already contains exactly one nested failure chain and no
  // circuit copy; do not wrap it in a second evaluation/failure tree.
  if (result.ok === true && (result.status === 'oscillating' || result.status === 'budget')) {
    return { ...result };
  }
  const compact = {
    status: result.status,
    reason: result.reason,
    pending: result.pending,
    stats: result.stats
  };
  if (result.failure) {
    compact.failure = result.failure;
  }
  return compact;
}

function outputVectorSignature(evaluation, definition, definitions) {
  const built = definitionBuilt(definition, definitions);
  return outputPorts(definition).map(function (port) {
    return portValue(evaluation, definition, port, built);
  }).join('');
}

// Semantic signature contains only logic state: outputs, pending frontier and
// nested instance state. Stats, traces, call counts and timing are excluded.
function semanticSignature(evaluation, state, definitions, stack) {
  const seen = stack || new Set();
  const ids = Object.keys(state.components).sort();
  let signature = ids.map(function (id) {
    const component = state.components[id];
    if (isCustom(component)) {
      const entry = evaluation.internal && evaluation.internal[id];
      if (!entry || seen.has(entry.definitionId)) {
        return 'C';
      }
      const definition = getDefinition(definitions, entry.definitionId);
      if (!definition) {
        return '?';
      }
      const nextSeen = new Set(seen);
      nextSeen.add(entry.definitionId);
      return 'C' + outputVectorSignature(entry.evaluation, definition, definitions) +
        '/' + semanticSignature(entry.evaluation, definition.circuit, definitions, nextSeen);
    }
    return own(evaluation.componentOutput, id) ? evaluation.componentOutput[id] : '-';
  }).join('');
  signature += '|' + ids.map(function (id) {
    return (evaluation.pending || []).indexOf(id) !== -1 ? '1' : '0';
  }).join('');
  return signature;
}

function initialInnerEvaluation(definition) {
  if (!definition || !definition.initialEvaluation) {
    return null;
  }
  return clone(definition.initialEvaluation);
}

// Diagnostic-only graph: a feedback connection is active only when its actual
// driver pin changed during the repeated period. Iterative Kosaraju avoids a
// call-stack limit on large circuits. Neither this graph nor its result is read
// by the simulator, state signature, or budget accounting.
function oscillatingFeedback(built, lastChangedRound, startRound) {
  const adjacency = new Map(), reverse = new Map();
  const activeNets = [];
  function node(id) {
    if (!adjacency.has(id)) {
      adjacency.set(id, new Set());
      reverse.set(id, new Set());
    }
  }
  for (const net of built.nets) {
    const driver = net.driverPins[0];
    if (!driver || !(lastChangedRound.get(driver.componentId + ':' + driver.pinId) > startRound)) continue;
    const from = driver.componentId;
    node(from);
    const targets = net.pins.filter(pin => pin.dir === 'in').map(pin => pin.componentId);
    for (const to of targets) {
      node(to);
      adjacency.get(from).add(to);
      reverse.get(to).add(from);
    }
    activeNets.push({ id: net.id, from, targets });
  }
  const seen = new Set(), order = [];
  for (const root of adjacency.keys()) {
    if (seen.has(root)) continue;
    seen.add(root);
    const stack = [{ id: root, next: adjacency.get(root).values() }];
    while (stack.length) {
      const top = stack[stack.length - 1];
      const next = top.next.next();
      if (next.done) {
        order.push(top.id);
        stack.pop();
      } else if (!seen.has(next.value)) {
        seen.add(next.value);
        stack.push({ id: next.value, next: adjacency.get(next.value).values() });
      }
    }
  }
  const groups = new Map(), cyclic = new Set(), componentIds = [];
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const root = order[i];
    if (groups.has(root)) continue;
    const members = [], stack = [root];
    groups.set(root, root);
    while (stack.length) {
      const id = stack.pop();
      members.push(id);
      for (const predecessor of reverse.get(id)) {
        if (!groups.has(predecessor)) {
          groups.set(predecessor, root);
          stack.push(predecessor);
        }
      }
    }
    if (members.length > 1 || adjacency.get(root).has(root)) {
      cyclic.add(root);
      for (const id of members) componentIds.push(id);
    }
  }
  const netIds = activeNets.filter(net => cyclic.has(groups.get(net.from)) &&
    net.targets.some(to => groups.get(to) === groups.get(net.from))).map(net => net.id);
  return { componentIds: componentIds.sort(), netIds: netIds.sort() };
}

export function evaluateDynamic(state, previous, limits, options) {
  const opts = options || {};
  const definitions = opts.definitions;
  const includeBarePins = opts.includeBarePins === true;
  const bounds = Object.assign({}, DEFAULT_DYNAMIC_LIMITS, limits || {});
  for (const key of Object.keys(DEFAULT_DYNAMIC_LIMITS)) {
    if (!Number.isFinite(bounds[key]) || bounds[key] < 0) throw new Error('Invalid dynamic budget: ' + key);
  }
  const built = buildNets(state, { definitions, includeBarePins });
  if (built.nets.some(net => net.driverPins.length > 1)) return { ok: false, reason: 'SECOND_DRIVER' };
  const netsById = new Map(built.nets.map(net => [net.id, net]));
  const ids = Object.keys(state.components).sort();
  const gates = ids.filter(id => isGate(state.components[id]));
  const hasCustom = ids.some(id => isCustom(state.components[id]));
  const componentOutput = {}, componentTypes = {}, pinValue = {}, netValue = {};
  const inputDrivers = {}, inputConnections = {}, lampOn = {};
  const internal = {};
  const old = previous || {};
  const oldInternal = old.internal && typeof old.internal === 'object' ? old.internal : {};
  const pending = new Set((old.pending || []).filter(id => state.components[id] && isGate(state.components[id])));
  const consumers = new Map();
  const netsByDriver = new Map();
  const stats = { rounds: 0, gateEvals: 0, events: 0, outputChanges: 0, peakPending: 0, historyBytes: 0 };
  const tracing = opts.trace === true;
  const trace = tracing ? [] : undefined;

  for (const id of ids) {
    const component = state.components[id];
    const pins = componentPins(component, definitions);
    if (!pins) {
      return {
        ok: false,
        reason: isCustom(component) ? 'INVALID_DEFINITION' : 'ILLEGAL_GEOMETRY',
        detail: isCustom(component) ? component.definitionId : component.type
      };
    }
    componentTypes[id] = component.type;

    if (isCustom(component)) {
      const definition = getDefinition(definitions, component.definitionId);
      if (!definition) {
        return { ok: false, reason: 'INVALID_DEFINITION', detail: component.definitionId };
      }
      const inheritedEntry = oldInternal[id];
      const inherited = Boolean(
        inheritedEntry &&
        inheritedEntry.definitionId === component.definitionId &&
        inheritedEntry.evaluation &&
        inheritedEntry.evaluation.ok === true &&
        inheritedEntry.evaluation.status === 'stable' &&
        Array.isArray(inheritedEntry.evaluation.pending) &&
        inheritedEntry.evaluation.pending.length === 0
      );
      const innerEvaluation = inherited
        ? inheritedEntry.evaluation
        : initialInnerEvaluation(definition);
      if (!innerEvaluation) {
        return { ok: false, reason: 'INVALID_DEFINITION', detail: component.definitionId + ':initialEvaluation' };
      }
      internal[id] = { definitionId: component.definitionId, evaluation: innerEvaluation };
      const definitionNets = definitionBuilt(definition, definitions);
      for (const port of outputPorts(definition)) {
        pinValue[id + ':' + port.id] = portValue(innerEvaluation, definition, port, definitionNets);
      }
      for (const port of inputPorts(definition)) {
        const key = id + ':' + port.id;
        pinValue[key] = 0;
        inputDrivers[key] = null;
        inputConnections[key] = null;
      }
      if (!inherited) {
        pending.add(id);
      }
      continue;
    }

    const inherited = old.componentTypes && old.componentTypes[id] === component.type &&
      old.componentOutput && own(old.componentOutput, id);
    if (component.type === 'CONST1') componentOutput[id] = 1;
    else if (component.type === 'TOGGLE' || component.type === 'BUTTON' ||
             component.type === 'CLOCK') {
      componentOutput[id] = component.on ? 1 : 0;
    } else if (GATES.has(component.type)) {
      componentOutput[id] = inherited ? bit(old.componentOutput[id]) : 0;
      if (!inherited) pending.add(id);
    }
    for (const pin of pins) {
      const key = id + ':' + pin.id;
      pinValue[key] = pin.dir === 'out' ? componentOutput[id] : 0;
      if (pin.dir === 'in') {
        inputDrivers[key] = null;
        inputConnections[key] = null;
      }
    }
  }

  for (const net of built.nets) {
    const driver = net.driverPins[0];
    const driverKey = driver ? driver.componentId + ':' + driver.pinId : null;
    const value = driver ? bit(pinValue[driverKey]) : 0;
    netValue[net.id] = value;
    if (driver) {
      if (!netsByDriver.has(driverKey)) netsByDriver.set(driverKey, []);
      netsByDriver.get(driverKey).push(net);
    }
    // Endpoints, rather than geometry/net representative id, identify topology edits.
    const connection = netConnectionSignature(state, net);
    for (const pin of net.pins) {
      const key = pin.componentId + ':' + pin.pinId;
      pinValue[key] = value;
      if (pin.dir === 'in') {
        inputDrivers[key] = driverKey;
        inputConnections[key] = connection;
        if (driver) {
          if (!consumers.has(driverKey)) consumers.set(driverKey, []);
          consumers.get(driverKey).push({ key, id: pin.componentId });
        }
      }
    }
  }

  // External boundary inputs for an inner definition are applied after normal
  // nets. They may only drive nets with no internal driver.
  for (const entry of opts.externalInputs || []) {
    const value = bit(entry.value);
    const netId = bindingNetId(built, entry.binding);
    const net = netId === undefined ? null : netsById.get(netId);
    if (entry.binding && entry.binding.kind === 'pin') {
      const key = entry.binding.componentId + ':' + entry.binding.pinId;
      pinValue[key] = value;
      const pin = net && net.pins.find(function (candidate) {
        return candidate.componentId === entry.binding.componentId &&
          candidate.pinId === entry.binding.pinId;
      });
      if (pin && pin.dir === 'in') {
        inputDrivers[key] = 'external:' + entry.portId;
        inputConnections[key] = 'external:' + entry.portId;
      }
    }
    if (netId === undefined) {
      continue;
    }
    if (net && net.driverPins.length > 0) {
      return {
        ok: false,
        reason: 'INVALID_DEFINITION',
        detail: 'external input port drives a net with an internal driver: ' + entry.portId
      };
    }
    netValue[netId] = value;
    if (net) {
      for (const pin of net.pins) {
        const key = pin.componentId + ':' + pin.pinId;
        pinValue[key] = value;
        if (pin.dir === 'in') {
          inputDrivers[key] = 'external:' + entry.portId;
          inputConnections[key] = 'external:' + entry.portId;
        }
      }
    }
  }

  for (const id of gates) {
    const component = state.components[id];
    if (isCustom(component)) {
      const definition = getDefinition(definitions, component.definitionId);
      if (!definition || !internal[id]) {
        pending.add(id);
        continue;
      }
      for (const port of inputPorts(definition)) {
        const key = id + ':' + port.id;
        if (!old.pinValue || pinValue[key] !== old.pinValue[key] ||
            !old.inputDrivers || inputDrivers[key] !== old.inputDrivers[key] ||
            !old.inputConnections || inputConnections[key] !== old.inputConnections[key]) {
          pending.add(id);
          break;
        }
      }
      continue;
    }
    for (const pin of COMPONENT_PINS[component.type]) {
      if (pin.dir !== 'in') continue;
      const key = id + ':' + pin.id;
      if (!old.pinValue || pinValue[key] !== old.pinValue[key] ||
          !old.inputDrivers || inputDrivers[key] !== old.inputDrivers[key] ||
          !old.inputConnections || inputConnections[key] !== old.inputConnections[key]) pending.add(id);
    }
  }

  function snapshot(round, processed, changed) {
    if (tracing) {
      const entry = { round, pending: processed.slice(), changed: changed.slice(), componentOutput: Object.assign({}, componentOutput) };
      if (hasCustom) entry.pinValue = Object.assign({}, pinValue);
      trace.push(entry);
    }
  }
  snapshot(0, Array.from(pending).sort(), []);

  // Acyclic circuits cannot repeat an event-driven state. Kahn only decides
  // whether history is necessary; it never changes round ordering or delay.
  const indegree = new Map(gates.map(id => [id, 0]));
  const adjacency = new Map(gates.map(id => [id, new Set()]));
  for (const [driverKey, targets] of consumers) {
    const split = driverKey.lastIndexOf(':');
    const driverId = split === -1 ? driverKey : driverKey.slice(0, split);
    if (!adjacency.has(driverId)) continue;
    for (const target of targets) {
      if (!indegree.has(target.id) || adjacency.get(driverId).has(target.id)) continue;
      adjacency.get(driverId).add(target.id);
      indegree.set(target.id, indegree.get(target.id) + 1);
    }
  }
  const ready = gates.filter(id => indegree.get(id) === 0);
  for (let index = 0; index < ready.length; index += 1) {
    for (const target of adjacency.get(ready[index])) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) ready.push(target);
    }
  }
  const hasFeedback = ready.length !== gates.length;
  // One entry per changing output, rather than a per-round trace/history.
  const lastChangedRound = hasFeedback ? new Map() : null;
  stats.hasFeedback = hasFeedback;
  const seen = new Map();
  let status = 'stable', cycle = null, failure = null;

  function publish(driverKey, value) {
    for (const net of netsByDriver.get(driverKey) || []) netValue[net.id] = value;
    for (const target of consumers.get(driverKey) || []) {
      pinValue[target.key] = value;
      if (isGate(state.components[target.id])) pending.add(target.id);
    }
  }

  while (pending.size) {
    stats.peakPending = Math.max(stats.peakPending, pending.size);
    const frontier = Array.from(pending).sort();
    // Fixed-width bit frontier avoids ID spelling/length affecting budget decisions.
    // historyBytes counts UTF-16 signature payload, excluding JS Map overhead.
    let signature = null;
    if (hasFeedback) {
      signature = ids.map(id => own(componentOutput, id) ? componentOutput[id] : '-').join('') +
        '|' + ids.map(id => pending.has(id) ? '1' : '0').join('');
      if (hasCustom) {
        signature += '|' + ids.filter(id => isCustom(state.components[id])).map(function (id) {
          const entry = internal[id];
          if (!entry) return '-';
          const definition = getDefinition(definitions, entry.definitionId);
          if (!definition) return '?';
          const nextStack = new Set([entry.definitionId]);
          return outputVectorSignature(entry.evaluation, definition, definitions) +
            '/' + semanticSignature(entry.evaluation, definition.circuit, definitions, nextStack);
        }).join('|');
      }
    }
    if (hasFeedback && seen.has(signature)) {
      status = 'oscillating';
      cycle = { startRound: seen.get(signature), period: stats.rounds - seen.get(signature) };
      break;
    }
    if (stats.rounds >= bounds.roundBudget || stats.gateEvals + pending.size > bounds.gateEvalBudget ||
        (hasFeedback && stats.historyBytes + signature.length * 2 > bounds.historyBudget)) {
      status = 'budget';
      break;
    }
    if (hasFeedback) {
      seen.set(signature, stats.rounds);
      stats.historyBytes += signature.length * 2;
    }

    const changed = [];
    const nextMeta = new Map();
    const nextCustom = new Map();
    // All reads happen before any writes. No identity, position, or queue priority.
    for (const id of frontier) {
      const component = state.components[id];
      if (isCustom(component)) {
        const definition = getDefinition(definitions, component.definitionId);
        const entry = internal[id];
        if (!definition || !entry) {
          failure = { kind: 'definition', reason: 'INVALID_DEFINITION', path: (opts.instancePath || []).concat(id) };
          break;
        }
        if ((opts.definitionStack || []).indexOf(component.definitionId) !== -1) {
          failure = { kind: 'recursive', reason: 'RECURSIVE_DEFINITION', path: (opts.instancePath || []).concat(id) };
          break;
        }
        const innerResult = evaluateDynamic(definition.circuit, entry.evaluation, limits, {
          definitions,
          includeBarePins: true,
          externalInputs: externalInputsForInstance({ pinValue }, id, definition),
          // Each level reports its own relative path; the caller prepends its
          // instance id. This keeps flattened diagnostics free of duplicates.
          instancePath: [],
          definitionStack: (opts.definitionStack || []).concat(component.definitionId)
        });
        const nestedPath = innerResult.failure && Array.isArray(innerResult.failure.path)
          ? innerResult.failure.path
          : [];
        if (!innerResult.ok) {
          failure = {
            kind: 'definition',
            reason: innerResult.reason,
            detail: innerResult.detail,
            path: (opts.instancePath || []).concat(id, nestedPath),
            inner: compactFailure(innerResult)
          };
          break;
        }
        if (innerResult.status !== 'stable') {
          failure = {
            kind: 'runtime',
            status: innerResult.status,
            reason: innerResult.reason,
            path: (opts.instancePath || []).concat(id, nestedPath),
            inner: compactFailure(innerResult)
          };
          break;
        }
        const definitionNets = definitionBuilt(definition, definitions);
        const outputs = {};
        const changedPins = [];
        for (const port of outputPorts(definition)) {
          const value = portValue(innerResult, definition, port, definitionNets);
          outputs[port.id] = value;
          if (pinValue[id + ':' + port.id] !== value) changedPins.push(port.id);
        }
        if (changedPins.length > 0) changed.push(id);
        nextCustom.set(id, {
          definitionId: component.definitionId,
          evaluation: innerResult,
          outputs,
          changedPins
        });
        continue;
      }

      const read = pin => bit(pinValue[id + ':' + pin]);
      let value;
      switch (component.type) {
        case 'NOT': value = 1 - read('in'); break;
        case 'DELAY': value = read('in'); break;
        case 'AND': value = read('a') & read('b'); break;
        case 'OR': value = read('a') | read('b'); break;
      }
      if (value !== componentOutput[id]) {
        nextMeta.set(id, value);
        changed.push(id);
      }
    }

    // A failed instance invalidates the whole attempted round: no sibling
    // output or internal state from this frontier is published.
    if (failure) {
      status = failure.kind === 'runtime' ? failure.status : 'budget';
      break;
    }

    pending.clear();
    stats.rounds += 1;
    stats.gateEvals += frontier.length;
    stats.events += frontier.length;
    stats.outputChanges += changed.length;

    for (const [id, value] of nextMeta) {
      componentOutput[id] = value;
      pinValue[id + ':out'] = value;
    }
    for (const [id, entry] of nextCustom) {
      internal[id] = { definitionId: entry.definitionId, evaluation: entry.evaluation };
      for (const portId of Object.keys(entry.outputs)) {
        pinValue[id + ':' + portId] = entry.outputs[portId];
      }
    }
    for (const [id, value] of nextMeta) {
      if (lastChangedRound) lastChangedRound.set(id + ':out', stats.rounds);
      publish(id + ':out', value);
    }
    for (const [id, entry] of nextCustom) {
      for (const portId of entry.changedPins) {
        if (lastChangedRound) lastChangedRound.set(id + ':' + portId, stats.rounds);
        publish(id + ':' + portId, entry.outputs[portId]);
      }
    }
    snapshot(stats.rounds, frontier, changed);
  }

  if (failure && failure.kind !== 'runtime') {
    return {
      ok: false,
      reason: failure.reason || 'INVALID_DEFINITION',
      detail: failure.detail,
      failure
    };
  }
  for (const id of ids) if (state.components[id].type === 'LAMP') lampOn[id] = pinValue[id + ':in'] === 1;
  const result = {
    ok: true,
    status,
    componentOutput,
    componentTypes,
    pinValue,
    netValue,
    lampOn,
    inputDrivers,
    inputConnections,
    pending: Array.from(pending).sort(),
    stats
  };
  if (hasCustom) result.internal = internal;
  if (failure) result.failure = failure;
  if (cycle) result.cycle = cycle;
  if (status === 'oscillating') {
    result.oscillation = cycle
      ? oscillatingFeedback(built, lastChangedRound, cycle.startRound)
      : { componentIds: failure && failure.path.length ? [failure.path[0]] : [], netIds: [] };
  }
  if (tracing) result.trace = trace;
  return result;
}
