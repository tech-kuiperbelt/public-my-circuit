// L1 definition validation and save-time contract.
//
// The validator keeps circuit boundaries: a CUSTOM instance is an atomic node
// whose stable relation is queried recursively. It never inlines child gates
// into the parent propagation graph. SAT_ALL is an existence proof over every
// definition input; resource exhaustion is reported as UNDECIDED.
import { componentPins, isWireGridPoint } from './geometry.js';
import { buildNets } from './nets.js';
import {
  bindingNetId,
  getDefinition,
  inputPorts,
  outputPorts,
  portValue,
  zeroExternalInputs
} from './ports.js';
import { evaluateDynamic } from './dynamic.js';
import { validateSnapshot } from './snapshot.js';

export const DEFAULT_DEFINITION_LIMITS = Object.freeze({
  gateEvalBudget: 8000000,
  maxInputs: 20,
  maxRelationRows: 4096,
  maxDepth: 32
});

const META_GATES = new Set(['NOT', 'AND', 'OR', 'DELAY']);
const ALL_TYPES = new Set(['CONST1', 'TOGGLE', 'BUTTON', 'NOT', 'AND', 'OR', 'DELAY', 'LAMP', 'CUSTOM']);
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value) {
  return typeof value === 'string' && value.length > 0;
}

function isBit(value) {
  return value === 0 || value === 1;
}

function bit(value) {
  return value === 1 ? 1 : 0;
}

function normalizeLimits(limits) {
  const source = limits || {};
  const normalized = {};
  for (const key of Object.keys(DEFAULT_DEFINITION_LIMITS)) {
    const value = source[key] === undefined ? DEFAULT_DEFINITION_LIMITS[key] : source[key];
    normalized[key] = value;
  }
  return normalized;
}

function libraryDefinitions(library) {
  if (!library) return new Map();
  if (library instanceof Map) return library;
  if (library.definitions instanceof Map) return library.definitions;
  if (library.definitions) return new Map(Object.entries(library.definitions));
  return new Map(Object.entries(library));
}

function definitionsList(library) {
  return Array.from(libraryDefinitions(library).values());
}

function isGateComponent(component) {
  return Boolean(component) && (META_GATES.has(component.type) || component.type === 'CUSTOM');
}

function collectDependencies(definition) {
  const ids = new Set();
  if (!definition || !definition.circuit || !isObject(definition.circuit.components)) {
    return [];
  }
  for (const component of Object.values(definition.circuit.components)) {
    if (component && component.type === 'CUSTOM' && isId(component.definitionId)) {
      ids.add(component.definitionId);
    }
  }
  return Array.from(ids).sort();
}

function validateCircuitShape(circuit, library) {
  if (!isObject(circuit) || !isObject(circuit.components) ||
      !isObject(circuit.wires) || !isObject(circuit.frames)) {
    return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'collections' };
  }
  if (!Number.isSafeInteger(circuit.nextId) || circuit.nextId < 1) {
    return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'nextId' };
  }
  for (const [id, component] of Object.entries(circuit.components)) {
    if (!isId(id) || !isObject(component) || component.id !== id) {
      return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'components.' + id };
    }
    if (!ALL_TYPES.has(component.type)) {
      return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'components.' + id + '.type' };
    }
    if (!Number.isInteger(component.cx) || !Number.isInteger(component.cy)) {
      return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'components.' + id + '.position' };
    }
    if (!Number.isInteger(component.rotation) || component.rotation < 0 || component.rotation > 3) {
      return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'components.' + id + '.rotation' };
    }
    if ((component.type === 'TOGGLE' || component.type === 'BUTTON') &&
        typeof component.on !== 'boolean') {
      return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'components.' + id + '.on' };
    }
    if (component.type === 'CUSTOM') {
      if (!isId(component.definitionId) || !getDefinition(library, component.definitionId)) {
        return { ok: false, reason: 'MISSING_DEFINITION', detail: component.definitionId };
      }
      if (!componentPins(component, library)) {
        return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'components.' + id + '.pins' };
      }
    }
  }
  for (const [id, wire] of Object.entries(circuit.wires)) {
    if (!isId(id) || !isObject(wire) || wire.id !== id) {
      return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'wires.' + id };
    }
    if (!Array.isArray(wire.points) || wire.points.length < 2) {
      return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'wires.' + id + '.points' };
    }
    for (let i = 0; i < wire.points.length; i += 1) {
      const point = wire.points[i];
      if (!isObject(point) || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
          !isWireGridPoint(point)) {
        return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'wires.' + id + '.points.' + i };
      }
    }
    for (const end of [wire.endA, wire.endB]) {
      if (!end || end.kind === 'free') continue;
      if (end.kind === 'pin') {
        const component = circuit.components[end.componentId];
        if (!component || !isId(end.pinId)) {
          return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'wires.' + id + '.pin' };
        }
        const pins = componentPins(component, library) || [];
        if (!pins.some(pin => pin.id === end.pinId)) {
          return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'wires.' + id + '.pin' };
        }
      } else if (end.kind === 'junction') {
        if (!isId(end.wireId) || !hasOwn(circuit.wires, end.wireId) ||
            !isObject(end.point) || !isWireGridPoint(end.point)) {
          return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'wires.' + id + '.junction' };
        }
      } else {
        return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'wires.' + id + '.end' };
      }
    }
  }
  for (const [id, frame] of Object.entries(circuit.frames)) {
    if (!isId(id) || !isObject(frame) || frame.id !== id) {
      return { ok: false, reason: 'INVALID_CIRCUIT', detail: 'frames.' + id };
    }
  }
  return { ok: true };
}

export function validateDefinitionStructure(candidate, library) {
  if (!isObject(candidate)) {
    return { ok: false, reason: 'INVALID_DEFINITION', detail: 'definition' };
  }
  if (!isId(candidate.id)) {
    return { ok: false, reason: 'INVALID_DEFINITION', detail: 'id' };
  }
  if (!isId(candidate.name)) {
    return { ok: false, reason: 'INVALID_DEFINITION', detail: 'name' };
  }
  if (candidate.icon !== undefined && candidate.icon !== null &&
      (typeof candidate.icon !== 'string' || candidate.icon.length === 0 ||
       candidate.icon.length > 32)) {
    return { ok: false, reason: 'INVALID_DEFINITION', detail: 'icon' };
  }
  for (const definition of definitionsList(library)) {
    if (definition.id !== candidate.id && definition.name === candidate.name) {
      return { ok: false, reason: 'DUPLICATE_NAME', detail: candidate.name };
    }
  }
  const circuitShape = validateCircuitShape(candidate.circuit, library);
  if (!circuitShape.ok) {
    return circuitShape;
  }
  if (!Array.isArray(candidate.ports)) {
    return { ok: false, reason: 'INVALID_PORTS', detail: 'ports' };
  }
  const portIds = new Set();
  for (const port of candidate.ports) {
    if (!isObject(port) || !isId(port.id) || !isId(port.name)) {
      return { ok: false, reason: 'INVALID_PORTS', detail: 'port' };
    }
    if (portIds.has(port.id)) {
      return { ok: false, reason: 'INVALID_PORTS', detail: 'duplicate-id:' + port.id };
    }
    portIds.add(port.id);
    if (port.direction !== 'in' && port.direction !== 'out') {
      return { ok: false, reason: 'INVALID_PORTS', detail: 'direction:' + port.id };
    }
    if (!isObject(port.binding) ||
        (port.binding.kind !== 'pin' && port.binding.kind !== 'wire')) {
      return { ok: false, reason: 'INVALID_PORTS', detail: 'binding:' + port.id };
    }
  }

  let built;
  try {
    built = buildNets(candidate.circuit, { definitions: library, includeBarePins: true });
  } catch (error) {
    return { ok: false, reason: 'INVALID_CIRCUIT', detail: String(error && error.message || error) };
  }
  for (const net of built.nets) {
    if (net.driverPins.length > 1) {
      return { ok: false, reason: 'SECOND_DRIVER', detail: net.id };
    }
  }
  const inputNets = new Set();
  for (const port of candidate.ports) {
    const netId = bindingNetId(built, port.binding);
    if (netId === undefined) {
      return { ok: false, reason: 'PORT_UNBOUND', detail: port.id };
    }
    const net = built.nets.find(candidateNet => candidateNet.id === netId);
    if (!net) {
      return { ok: false, reason: 'PORT_UNBOUND', detail: port.id };
    }
    if (port.direction === 'in') {
      if (net.driverPins.length !== 0) {
        return { ok: false, reason: 'INPUT_PORT_DRIVEN', detail: port.id };
      }
      if (inputNets.has(netId)) {
        return { ok: false, reason: 'DUPLICATE_PORT_NET', detail: port.id };
      }
      inputNets.add(netId);
    } else if (net.driverPins.length !== 1) {
      return { ok: false, reason: 'OUTPUT_PORT_UNDRIVEN', detail: port.id };
    }
  }
  return {
    ok: true,
    built,
    dependencies: collectDependencies(candidate)
  };
}

function checkRecursion(candidate, library) {
  const visiting = new Set();
  const visited = new Set();
  function visit(definition) {
    if (!definition) return null;
    if (visiting.has(definition.id)) {
      return definition.id;
    }
    if (visited.has(definition.id)) {
      return null;
    }
    visiting.add(definition.id);
    for (const dependency of collectDependencies(definition)) {
      const child = getDefinition(library, dependency);
      if (!child) {
        visiting.delete(definition.id);
        return dependency;
      }
      const recursive = visit(child);
      if (recursive) {
        visiting.delete(definition.id);
        return recursive;
      }
    }
    visiting.delete(definition.id);
    visited.add(definition.id);
    return null;
  }
  const recursive = visit(candidate);
  if (recursive) {
    return { ok: false, reason: 'RECURSIVE_DEFINITION', detail: recursive };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// L1 relation solving

function tarjan(n, adj) {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const sccOf = new Int32Array(n).fill(-1);
  const stack = [];
  const sccs = [];
  let counter = 0;

  function strongConnect(v) {
    index[v] = counter;
    low[v] = counter;
    counter += 1;
    stack.push(v);
    onStack[v] = 1;
    for (const w of adj[v]) {
      if (index[w] === -1) {
        strongConnect(w);
        if (low[w] < low[v]) low[v] = low[w];
      } else if (onStack[w] && index[w] < low[v]) {
        low[v] = index[w];
      }
    }
    if (low[v] === index[v]) {
      const component = [];
      for (;;) {
        const w = stack.pop();
        onStack[w] = 0;
        sccOf[w] = sccs.length;
        component.push(w);
        if (w === v) break;
      }
      component.sort(function (a, b) { return a - b; });
      sccs.push(component);
    }
  }

  for (let v = 0; v < n; v += 1) {
    if (index[v] === -1) strongConnect(v);
  }
  return { sccs, sccOf };
}

function hasCycle(nodes, adj) {
  const color = new Map();
  for (const node of nodes) color.set(node, 0);
  function visit(v) {
    color.set(v, 1);
    for (const w of adj[v]) {
      if (!color.has(w)) continue;
      if (color.get(w) === 1) return true;
      if (color.get(w) === 0 && visit(w)) return true;
    }
    color.set(v, 2);
    return false;
  }
  for (const node of nodes) {
    if (color.get(node) === 0 && visit(node)) return true;
  }
  return false;
}

function feedbackForScc(scc, adj, radj, nodes) {
  const remaining = new Set(scc);
  const feedback = new Set();
  while (hasCycle(remaining, adj)) {
    let best = -1;
    let bestScore = -Infinity;
    for (const node of remaining) {
      let degree = 0;
      for (const target of adj[node]) if (remaining.has(target)) degree += 1;
      for (const source of radj[node]) if (remaining.has(source)) degree += 1;
      // Prefer removing a stateful node (a CUSTOM whose child relation can be
      // multi-valued) over a combinational node. Enumerating a combinational
      // node's output vector is redundant work; stateful nodes are the real
      // fixed-point variables.
      const stateful = nodes && nodes[node] && nodes[node].kind === 'custom' &&
        !nodes[node].singleValuedChild;
      const score = degree + (stateful ? 1000 : 0);
      if (score > bestScore || (score === bestScore && (best === -1 || node < best))) {
        best = node;
        bestScore = score;
      }
    }
    remaining.delete(best);
    feedback.add(best);
  }
  return { feedback, remaining: Array.from(remaining).sort(function (a, b) { return a - b; }) };
}

function buildGraph(definition, library, built) {
  const nets = built || buildNets(definition.circuit, { definitions: library, includeBarePins: true });
  const netsById = new Map(nets.nets.map(net => [net.id, net]));
  const xPorts = inputPorts(definition);
  const yPorts = outputPorts(definition);
  const xNet = new Map();
  for (let i = 0; i < xPorts.length; i += 1) {
    const netId = bindingNetId(nets, xPorts[i].binding);
    if (netId !== undefined) xNet.set(netId, i);
  }
  const componentIds = Object.keys(definition.circuit.components).sort();
  const nodes = [];
  const nodeIndex = new Map();
  for (const id of componentIds) {
    const component = definition.circuit.components[id];
    if (!isGateComponent(component)) continue;
    nodeIndex.set(id, nodes.length);
    nodes.push({ id, component, kind: component.type === 'CUSTOM' ? 'custom' : 'meta' });
  }
  const pinOwner = new Map();
  for (const node of nodes) {
    const component = node.component;
    if (node.kind === 'custom') {
      node.definition = getDefinition(library, component.definitionId);
      node.inputPins = inputPorts(node.definition).map(port => port.id);
      node.outputPins = outputPorts(node.definition).map(port => port.id);
    } else {
      const pins = componentPins(component, library) || [];
      node.inputPins = pins.filter(pin => pin.dir === 'in').map(pin => pin.id);
      node.outputPins = pins.filter(pin => pin.dir === 'out').map(pin => pin.id);
    }
    for (let i = 0; i < node.outputPins.length; i += 1) {
      pinOwner.set(node.id + ':' + node.outputPins[i], {
        node: nodeIndex.get(node.id),
        pin: i
      });
    }
  }

  function resolveNet(netId) {
    if (netId === undefined) return { kind: 'const', value: 0 };
    if (xNet.has(netId)) return { kind: 'x', index: xNet.get(netId) };
    const net = netsById.get(netId);
    if (!net || net.driverPins.length !== 1) return { kind: 'const', value: 0 };
    const driver = net.driverPins[0];
    const owner = pinOwner.get(driver.componentId + ':' + driver.pinId);
    if (owner) return { kind: 'node', node: owner.node, pin: owner.pin };
    const source = definition.circuit.components[driver.componentId];
    if (source && source.type === 'CONST1') return { kind: 'const', value: 1 };
    if (source && source.type === 'TOGGLE') return { kind: 'const', value: source.on ? 1 : 0 };
    if (source && source.type === 'BUTTON') return { kind: 'const', value: source.on ? 1 : 0 };
    return { kind: 'const', value: 0 };
  }

  for (const node of nodes) {
    node.inputs = node.inputPins.map(function (pinId) {
      return resolveNet(nets.netIdOfPin[node.id + ':' + pinId]);
    });
  }
  const yDrivers = yPorts.map(function (port) {
    return resolveNet(bindingNetId(nets, port.binding));
  });

  const adj = nodes.map(function () { return []; });
  const radj = nodes.map(function () { return []; });
  const edgeSeen = new Set();
  for (let target = 0; target < nodes.length; target += 1) {
    for (const input of nodes[target].inputs) {
      if (input.kind !== 'node') continue;
      const key = input.node + '>' + target;
      if (edgeSeen.has(key)) continue;
      edgeSeen.add(key);
      adj[input.node].push(target);
      radj[target].push(input.node);
    }
  }
  for (let i = 0; i < nodes.length; i += 1) {
    adj[i].sort(function (a, b) { return a - b; });
    radj[i].sort(function (a, b) { return a - b; });
  }

  return {
    definition,
    built: nets,
    nodes,
    nodeIndex,
    adj,
    radj,
    xPorts,
    yPorts,
    yDrivers,
    xNet
  };
}

function planGraph(graph, resolver) {
  const n = graph.nodes.length;
  const tarjanResult = tarjan(n, graph.adj);
  const feedbackSet = new Set();
  const feedbackSccs = [];
  for (const scc of tarjanResult.sccs) {
    const selfLoop = scc.length === 1 && graph.adj[scc[0]].indexOf(scc[0]) !== -1;
    if (scc.length === 1 && !selfLoop) continue;
    for (const nodeIndex of scc) {
      const node = graph.nodes[nodeIndex];
      if (node.kind === 'custom' && node.singleValuedChild === undefined) {
        node.singleValuedChild = isSingleValued(node.definition, resolver, []);
      }
    }
    const plan = feedbackForScc(scc, graph.adj, graph.radj, graph.nodes);
    for (const node of plan.feedback) feedbackSet.add(node);
    feedbackSccs.push({
      nodes: scc.slice(),
      feedback: Array.from(plan.feedback).sort(function (a, b) { return a - b; })
    });
  }
  const feedbackNodes = Array.from(feedbackSet).sort(function (a, b) { return a - b; });
  const remaining = [];
  for (let i = 0; i < n; i += 1) if (!feedbackSet.has(i)) remaining.push(i);
  const indegree = new Map(remaining.map(function (node) { return [node, 0]; }));
  for (const node of remaining) {
    for (const target of graph.adj[node]) {
      if (indegree.has(target)) indegree.set(target, indegree.get(target) + 1);
    }
  }
  const ready = remaining.filter(function (node) { return indegree.get(node) === 0; });
  ready.sort(function (a, b) { return a - b; });
  const topoOrder = [];
  while (ready.length > 0) {
    const node = ready.shift();
    topoOrder.push(node);
    for (const target of graph.adj[node]) {
      if (!indegree.has(target)) continue;
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) {
        ready.push(target);
        ready.sort(function (a, b) { return a - b; });
      }
    }
  }
  if (topoOrder.length !== remaining.length) {
    // Defensive fallback: enumerate every node rather than silently changing
    // the semantic. This should not happen after per-SCC feedback removal.
    for (const node of remaining) feedbackSet.add(node);
    return {
      feedbackNodes: Array.from(feedbackSet).sort(function (a, b) { return a - b; }),
      topoOrder: [],
      feedbackSccs,
      fallback: true
    };
  }
  return { feedbackNodes, topoOrder, feedbackSccs };
}

function readInputs(graph, node, assignment, x) {
  const values = [];
  for (const input of node.inputs) {
    if (input.kind === 'const') {
      values.push(input.value);
    } else if (input.kind === 'x') {
      values.push(bit(x[input.index]));
    } else {
      const assigned = assignment[input.node];
      values.push(assigned ? assigned[input.pin] : undefined);
    }
  }
  return values;
}

function computeMeta(node, values) {
  const type = node.component.type;
  if (type === 'NOT') return [1 - bit(values[0])];
  if (type === 'DELAY') return [bit(values[0])];
  if (type === 'AND') return [bit(values[0]) & bit(values[1])];
  if (type === 'OR') return [bit(values[0]) | bit(values[1])];
  return [0];
}

function sameVector(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function bitsFromMask(mask, count) {
  const bits = new Array(count);
  for (let i = 0; i < count; i += 1) bits[i] = (mask >>> i) & 1;
  return bits;
}

function makeWitness(graph, assignment, chosenChildren) {
  const nodes = {};
  for (let i = 0; i < graph.nodes.length; i += 1) {
    if (assignment[i]) nodes[graph.nodes[i].id] = assignment[i].slice();
  }
  const children = {};
  for (const id of Object.keys(chosenChildren)) {
    children[id] = chosenChildren[id];
  }
  return { nodes, children };
}

function solveGraph(graph, x, resolver, stackIds, options) {
  const plan = graph.plan || planGraph(graph, resolver);
  const stopAfterFirst = Boolean(options && options.stopAfterFirst);
  const budget = resolver.budget;
  const assignment = new Array(graph.nodes.length);
  const chosenChildren = {};
  const results = new Map();
  let incomplete = false;
  let done = false;
  let reason = null;

  function stop(nextReason) {
    if (!incomplete) {
      incomplete = true;
      reason = nextReason;
    }
  }

  function record() {
    for (const nodeIndex of plan.feedbackNodes) {
      const node = graph.nodes[nodeIndex];
      const values = readInputs(graph, node, assignment, x);
      if (values.some(value => value === undefined)) {
        stop('topology_incomplete');
        return;
      }
      if (node.kind === 'meta') {
        const expected = computeMeta(node, values);
        if (!sameVector(expected, assignment[nodeIndex])) return;
      } else {
        const child = relationFor(node.definition, values, stackIds, resolver);
        if (!child.complete) {
          stop(child.reason || 'child_undecided');
          return;
        }
        const match = child.rows.find(function (row) {
          return sameVector(row.outputs, assignment[nodeIndex]);
        });
        if (!match) return;
        chosenChildren[node.id] = match.witness;
      }
    }
    const outputs = graph.yDrivers.map(function (driver) {
      if (driver.kind === 'const') return driver.value;
      if (driver.kind === 'x') return bit(x[driver.index]);
      return assignment[driver.node] ? assignment[driver.node][driver.pin] : 0;
    });
    const key = outputs.join('');
    if (!results.has(key)) {
      results.set(key, {
        outputs,
        witness: makeWitness(graph, assignment, chosenChildren)
      });
      if (results.size > resolver.limits.maxRelationRows) {
        stop('relation_rows_limit');
      }
      if (stopAfterFirst) done = true;
    }
  }

  function evaluateRemaining(position) {
    if (incomplete || done) return;
    if (position === plan.topoOrder.length) {
      record();
      return;
    }
    const nodeIndex = plan.topoOrder[position];
    const node = graph.nodes[nodeIndex];
    const values = readInputs(graph, node, assignment, x);
    if (values.some(value => value === undefined)) {
      stop('topology_incomplete');
      return;
    }
    if (node.kind === 'meta') {
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        stop('verification_budget');
        return;
      }
      assignment[nodeIndex] = computeMeta(node, values);
      evaluateRemaining(position + 1);
      return;
    }
    const child = relationFor(node.definition, values, stackIds, resolver);
    if (!child.complete) {
      stop(child.reason || 'child_undecided');
      return;
    }
    if (child.rows.length === 0) return;
    for (const row of child.rows) {
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        stop('verification_budget');
        return;
      }
      assignment[nodeIndex] = row.outputs.slice();
      chosenChildren[node.id] = row.witness;
      evaluateRemaining(position + 1);
      if (incomplete || done) return;
    }
  }

  function assignFeedback(position) {
    if (incomplete || done) return;
    if (position === plan.feedbackNodes.length) {
      evaluateRemaining(0);
      return;
    }
    const nodeIndex = plan.feedbackNodes[position];
    const node = graph.nodes[nodeIndex];
    const count = node.outputPins.length;
    if (count > 20) {
      stop('feedback_vars_limit');
      return;
    }
    const space = Math.pow(2, count);
    for (let mask = 0; mask < space; mask += 1) {
      budget.remaining -= 1;
      if (budget.remaining < 0) {
        stop('verification_budget');
        return;
      }
      assignment[nodeIndex] = bitsFromMask(mask, count);
      assignFeedback(position + 1);
      if (incomplete || done) return;
    }
  }

  assignFeedback(0);
  return {
    complete: !incomplete,
    rows: Array.from(results.values()),
    reason
  };
}

function isSingleValued(definition, resolver, stackIds) {
  if (!definition) return false;
  if (stackIds.indexOf(definition.id) !== -1) return false;
  if (resolver.singleValuedCache.has(definition)) {
    return resolver.singleValuedCache.get(definition);
  }
  const graph = graphFor(definition, resolver);
  const sccResult = tarjan(graph.nodes.length, graph.adj);
  let single = true;
  for (const scc of sccResult.sccs) {
    const selfLoop = scc.length === 1 && graph.adj[scc[0]].indexOf(scc[0]) !== -1;
    if (scc.length > 1 || selfLoop) {
      single = false;
      break;
    }
  }
  if (single) {
    for (const node of graph.nodes) {
      if (node.kind === 'custom' &&
          !isSingleValued(node.definition, resolver, stackIds.concat(definition.id))) {
        single = false;
        break;
      }
    }
  }
  resolver.singleValuedCache.set(definition, single);
  return single;
}

function evaluateSingleValued(graph, x, resolver, stackIds) {
  const plan = planGraph(graph, resolver);
  if (plan.feedbackNodes.length > 0) return null;
  const assignment = new Array(graph.nodes.length);
  const chosenChildren = {};
  for (const nodeIndex of plan.topoOrder) {
    const node = graph.nodes[nodeIndex];
    const values = readInputs(graph, node, assignment, x);
    if (values.some(value => value === undefined)) {
      return { complete: false, rows: [], reason: 'topology_incomplete' };
    }
    if (node.kind === 'meta') {
      resolver.budget.remaining -= 1;
      if (resolver.budget.remaining < 0) {
        return { complete: false, rows: [], reason: 'verification_budget' };
      }
      assignment[nodeIndex] = computeMeta(node, values);
      continue;
    }
    const child = relationFor(node.definition, values, stackIds, resolver);
    if (!child.complete) {
      return { complete: false, rows: [], reason: child.reason || 'child_undecided' };
    }
    if (child.rows.length !== 1) {
      return null;
    }
    resolver.budget.remaining -= 1;
    if (resolver.budget.remaining < 0) {
      return { complete: false, rows: [], reason: 'verification_budget' };
    }
    assignment[nodeIndex] = child.rows[0].outputs.slice();
    chosenChildren[node.id] = child.rows[0].witness;
  }
  const outputs = graph.yDrivers.map(function (driver) {
    if (driver.kind === 'const') return driver.value;
    if (driver.kind === 'x') return bit(x[driver.index]);
    return assignment[driver.node] ? assignment[driver.node][driver.pin] : 0;
  });
  return {
    complete: true,
    rows: [{ outputs, witness: makeWitness(graph, assignment, chosenChildren) }],
    reason: null
  };
}

function relationFor(definition, x, stackIds, resolver) {
  if (!definition) {
    return { complete: false, rows: [], reason: 'missing_definition' };
  }
  if (stackIds.indexOf(definition.id) !== -1) {
    return { complete: false, rows: [], reason: 'RECURSIVE_DEFINITION', recursive: true };
  }
  if (stackIds.length >= resolver.limits.maxDepth) {
    return { complete: false, rows: [], reason: 'depth_limit' };
  }
  let cache = resolver.relationCache.get(definition);
  if (!cache) {
    cache = new Map();
    resolver.relationCache.set(definition, cache);
  }
  const key = x.join('');
  if (cache.has(key)) return cache.get(key);
  const graph = graphFor(definition, resolver);
  if (isSingleValued(definition, resolver, stackIds)) {
    const fast = evaluateSingleValued(graph, x, resolver, stackIds.concat(definition.id));
    if (fast) {
      cache.set(key, fast);
      return fast;
    }
  }
  const result = solveGraph(graph, x, resolver, stackIds.concat(definition.id));
  cache.set(key, result);
  return result;
}

function graphFor(definition, resolver) {
  let graph = resolver.graphCache.get(definition);
  if (graph) return graph;
  const built = buildNets(definition.circuit, {
    definitions: resolver.library,
    includeBarePins: true
  });
  graph = buildGraph(definition, resolver.library, built);
  resolver.graphCache.set(definition, graph);
  return graph;
}

function relevantInputIndices(graph, feedbackNodes) {
  const visited = new Set(feedbackNodes);
  const stack = feedbackNodes.slice();
  const relevant = new Set();
  while (stack.length > 0) {
    const nodeIndex = stack.pop();
    for (const input of graph.nodes[nodeIndex].inputs) {
      if (input.kind === 'x') {
        relevant.add(input.index);
      } else if (input.kind === 'node' && !visited.has(input.node)) {
        visited.add(input.node);
        stack.push(input.node);
      }
    }
  }
  return Array.from(relevant).sort(function (a, b) { return a - b; });
}

function analyzeWithMemo(definition, resolver, memo, stackIds) {
  if (memo.has(definition.id)) return memo.get(definition.id);
  if (stackIds.indexOf(definition.id) !== -1) {
    return { status: 'unsat', reason: 'RECURSIVE_DEFINITION', recursive: true, gateEvals: 0, dependencies: {} };
  }
  const structure = validateDefinitionStructure(definition, resolver.library);
  if (!structure.ok) {
    return {
      status: 'unsat',
      reason: structure.reason,
      detail: structure.detail,
      gateEvals: 0,
      dependencies: {}
    };
  }
  const dependencies = {};
  for (const id of structure.dependencies) {
    const child = getDefinition(resolver.library, id);
    if (!child) {
      return { status: 'unsat', reason: 'MISSING_DEFINITION', detail: id, gateEvals: 0, dependencies };
    }
    const childResult = analyzeWithMemo(child, resolver, memo, stackIds.concat(definition.id));
    dependencies[id] = { status: childResult.status, reason: childResult.reason };
    if (childResult.recursive) {
      return {
        status: 'unsat',
        reason: 'RECURSIVE_DEFINITION',
        recursive: true,
        gateEvals: 0,
        dependencies
      };
    }
  }

  const graph = graphFor(definition, resolver);
  const plan = planGraph(graph, resolver);
  graph.plan = plan;
  const allDependenciesSat = Object.keys(dependencies).every(function (id) {
    return dependencies[id].status === 'sat_all';
  });
  const numInputs = graph.xPorts.length;
  let status = 'sat_all';
  let reason = 'accepted';
  let relevantInputs = [];

  if (plan.feedbackNodes.length === 0 && allDependenciesSat) {
    status = 'sat_all';
    reason = 'structural_induction';
  } else {
    const allInputs = Array.from({ length: numInputs }, function (_, index) { return index; });
    // If any dependency is not SAT_ALL, an acyclic child outside the feedback
    // input cone may still have an UNSAT/UNDECIDED input. In that exceptional
    // case enumerate every parent input rather than assuming the child is safe.
    const xIndices = plan.feedbackNodes.length === 0 || !allDependenciesSat
      ? allInputs
      : relevantInputIndices(graph, plan.feedbackNodes);
    relevantInputs = xIndices;
    if (xIndices.length > resolver.limits.maxInputs) {
      status = 'undecided';
      reason = 'input_space_limit';
    } else {
      const space = Math.pow(2, xIndices.length);
      for (let mask = 0; mask < space; mask += 1) {
        const x = new Array(numInputs).fill(0);
        for (let i = 0; i < xIndices.length; i += 1) {
          x[xIndices[i]] = (mask >>> i) & 1;
        }
        const result = solveGraph(graph, x, resolver, [definition.id], { stopAfterFirst: true });
        if (!result.complete) {
          status = 'undecided';
          reason = result.reason || 'undecided';
          break;
        }
        if (result.rows.length === 0) {
          status = 'unsat';
          reason = 'no_fixed_point';
          break;
        }
      }
    }
  }

  const result = {
    status,
    reason,
    gateEvals: resolver.limits.gateEvalBudget - resolver.budget.remaining,
    inputCount: numInputs,
    relevantInputs,
    feedbackNodes: plan.feedbackNodes,
    feedbackSccs: plan.feedbackSccs,
    dependencies
  };
  memo.set(definition.id, result);
  return result;
}

export function analyzeDefinitionL1(candidate, library, limits) {
  const normalized = normalizeLimits(limits);
  const recursion = checkRecursion(candidate, library);
  if (!recursion.ok) {
    return {
      status: 'unsat',
      reason: recursion.reason,
      detail: recursion.detail,
      gateEvals: 0,
      dependencies: {},
      recursive: true
    };
  }
  const resolver = {
    library,
    limits: normalized,
    budget: { remaining: normalized.gateEvalBudget },
    graphCache: new WeakMap(),
    relationCache: new WeakMap(),
    singleValuedCache: new WeakMap(),
    memo: new Map()
  };
  return analyzeWithMemo(candidate, resolver, new Map(), []);
}

function validateInitialEvaluation(candidate, library, structure, limits) {
  const initial = candidate.initialEvaluation;
  if (!isObject(initial)) {
    return { ok: false, reason: 'MISSING_INITIAL_EVALUATION' };
  }
  if (initial.ok !== true || initial.status !== 'stable' || !Array.isArray(initial.pending) ||
      initial.pending.length !== 0) {
    return {
      ok: false,
      reason: 'INITIAL_NOT_STABLE',
      detail: initial.status,
      evaluation: initial
    };
  }
  for (const port of inputPorts(candidate)) {
    if (portValue(initial, candidate, port, structure.built) !== 0) {
      return { ok: false, reason: 'INITIAL_INPUT_NONZERO', detail: port.id };
    }
  }
  const externalInputs = zeroExternalInputs(candidate);
  const snapshotResult = validateSnapshot(
    { state: candidate.circuit, evaluation: initial },
    { definitions: library, includeBarePins: true, externalInputs }
  );
  if (!snapshotResult.ok) {
    return {
      ok: false,
      reason: 'INITIAL_INVALID',
      detail: snapshotResult.reason + (snapshotResult.detail ? ':' + snapshotResult.detail : '')
    };
  }
  const result = evaluateDynamic(candidate.circuit, initial, limits, {
    definitions: library,
    includeBarePins: true,
    externalInputs
  });
  if (!result.ok) {
    return { ok: false, reason: 'INITIAL_INVALID', detail: result.reason };
  }
  if (result.status !== 'stable') {
    return { ok: false, reason: 'INITIAL_NOT_STABLE', detail: result.status };
  }
  if (result.stats.rounds !== 0 || result.pending.length !== 0) {
    return { ok: false, reason: 'INITIAL_NOT_FIXED_POINT' };
  }
  return { ok: true, reason: 'accepted', evaluation: initial };
}

export function validateDefinitionLibrary(library, limits) {
  const definitions = libraryDefinitions(library);
  const names = new Set();
  for (const [id, definition] of definitions) {
    if (!isObject(definition) || definition.id !== id || !isId(definition.name)) {
      return { ok: false, reason: 'INVALID_LIBRARY', detail: id };
    }
    if (names.has(definition.name)) {
      return { ok: false, reason: 'DUPLICATE_NAME', detail: definition.name };
    }
    names.add(definition.name);
  }
  for (const [id, definition] of definitions) {
    const result = validateDefinitionSave(definition, library, limits);
    if (!result.ok) {
      return {
        ok: false,
        reason: 'LIBRARY_INVALID',
        detail: id + ':' + result.reason,
        result
      };
    }
  }
  return { ok: true };
}

export function validateDefinitionSave(candidate, library, limits) {
  const normalized = normalizeLimits(limits);
  const structure = validateDefinitionStructure(candidate, library);
  if (!structure.ok) {
    return {
      ok: false,
      status: 'unsat',
      reason: structure.reason,
      detail: structure.detail,
      gateEvals: 0,
      checks: { structure }
    };
  }
  const recursion = checkRecursion(candidate, library);
  if (!recursion.ok) {
    return {
      ok: false,
      status: 'unsat',
      reason: recursion.reason,
      detail: recursion.detail,
      gateEvals: 0,
      checks: { structure, recursion }
    };
  }
  const l1 = analyzeDefinitionL1(candidate, library, normalized);
  if (l1.status !== 'sat_all') {
    return {
      ok: false,
      status: l1.status,
      reason: l1.reason,
      gateEvals: l1.gateEvals,
      l1,
      dependencies: l1.dependencies,
      checks: { structure, recursion, l1 }
    };
  }
  const initial = validateInitialEvaluation(candidate, library, structure, normalized);
  if (!initial.ok) {
    return {
      ok: false,
      status: l1.status,
      reason: initial.reason,
      detail: initial.detail,
      gateEvals: l1.gateEvals,
      l1,
      initial,
      dependencies: l1.dependencies,
      checks: { structure, recursion, l1, initial }
    };
  }
  return {
    ok: true,
    status: 'sat_all',
    reason: 'accepted',
    gateEvals: l1.gateEvals,
    l1,
    initial,
    dependencies: l1.dependencies,
    checks: { structure, recursion, l1, initial }
  };
}
