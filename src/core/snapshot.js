import { netConnectionSignature } from './topology-signature.js';
// L2 运行状态快照：完整 state + evaluation 的构造与只读验证。
// M6 后续持久化记录（schemaVersion/view）由 L3 负责；这里不引入第二个版本号，
// 也不调用 evaluateDynamic，避免验证本身推进引擎或产生额外时钟边沿。
import { CLOCK_MAX_PERIOD, CLOCK_MIN_PERIOD } from './entities.js';
import { COMPONENT_PINS, componentPins, isWireGridPoint } from './geometry.js';
import { buildNets } from './nets.js';
import {
  bindingNetId,
  externalInputsForInstance,
  getDefinition,
  inputPorts,
  outputPorts,
  portValue
} from './ports.js';

const GATES = new Set(['NOT', 'AND', 'OR', 'DELAY']);
const OUTPUT_TYPES = new Set(['CONST1', 'TOGGLE', 'BUTTON', 'CLOCK', 'NOT', 'AND', 'OR', 'DELAY']);
const STATUSES = new Set(['stable', 'oscillating', 'budget']);
const GENERATED_ID = /^[cwf](\d+)$/;

export const SNAPSHOT_REASONS = Object.freeze({
  INVALID_SNAPSHOT: 'INVALID_SNAPSHOT',
  INVALID_STATE: 'INVALID_STATE',
  INVALID_EVALUATION: 'INVALID_EVALUATION',
  INCONSISTENT: 'INCONSISTENT'
});

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

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(value) {
  return isObject(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function fail(reason, detail) {
  return { ok: false, reason, detail };
}

function clone(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function sameKeys(object, expected) {
  if (!isObject(object)) {
    return false;
  }
  const actualKeys = Object.keys(object).sort();
  const expectedKeys = expected.slice().sort();
  if (actualKeys.length !== expectedKeys.length) {
    return false;
  }
  for (let i = 0; i < actualKeys.length; i += 1) {
    if (actualKeys[i] !== expectedKeys[i]) {
      return false;
    }
  }
  return true;
}

function pinDefinition(component, pinId, definitions) {
  const pins = componentPins(component, definitions) || [];
  for (const pin of pins) {
    if (pin.id === pinId) {
      return pin;
    }
  }
  return null;
}

function validateEnd(state, end, path, definitions) {
  if (end === null || end === undefined) {
    return { ok: true };
  }
  if (!isObject(end)) {
    return fail(SNAPSHOT_REASONS.INVALID_STATE, path);
  }
  if (end.kind === 'free') {
    return { ok: true };
  }
  if (end.kind === 'pin') {
    if (!isId(end.componentId) || !isId(end.pinId)) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, path);
    }
    const component = state.components[end.componentId];
    if (!component || !pinDefinition(component, end.pinId, definitions)) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, path);
    }
    return { ok: true };
  }
  if (end.kind === 'junction') {
    if (!isId(end.wireId) || !hasOwn(state.wires, end.wireId) ||
        !isPoint(end.point) || !isWireGridPoint(end.point)) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, path);
    }
    return { ok: true };
  }
  return fail(SNAPSHOT_REASONS.INVALID_STATE, path);
}

function validateState(state, options) {
  const definitions = options && options.definitions;
  const includeBarePins = Boolean(options && options.includeBarePins);
  if (!isObject(state)) {
    return fail(SNAPSHOT_REASONS.INVALID_STATE, 'state');
  }
  if (!isObject(state.components) || !isObject(state.wires) || !isObject(state.frames)) {
    return fail(SNAPSHOT_REASONS.INVALID_STATE, 'state.collections');
  }
  if (!Number.isSafeInteger(state.nextId) || state.nextId < 1) {
    return fail(SNAPSHOT_REASONS.INVALID_STATE, 'state.nextId');
  }

  let maxGeneratedSuffix = 0;
  for (const [id, component] of Object.entries(state.components)) {
    if (!isId(id) || !isObject(component) || component.id !== id) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'components.' + id);
    }
    if (component.type === 'CUSTOM') {
      if (!isId(component.definitionId) || !getDefinition(definitions, component.definitionId)) {
        return fail(SNAPSHOT_REASONS.INVALID_STATE, 'components.' + id + '.definitionId');
      }
      if (!componentPins(component, definitions)) {
        return fail(SNAPSHOT_REASONS.INVALID_STATE, 'components.' + id + '.pins');
      }
    } else if (!hasOwn(COMPONENT_PINS, component.type)) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'components.' + id + '.type');
    }
    if (!Number.isInteger(component.cx) || !Number.isInteger(component.cy)) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'components.' + id + '.position');
    }
    if (!Number.isInteger(component.rotation) || component.rotation < 0 || component.rotation > 3) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'components.' + id + '.rotation');
    }
    if ((component.type === 'TOGGLE' || component.type === 'BUTTON') &&
        typeof component.on !== 'boolean') {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'components.' + id + '.on');
    }
    if (component.type === 'CLOCK') {
      if (typeof component.on !== 'boolean') {
        return fail(SNAPSHOT_REASONS.INVALID_STATE, 'components.' + id + '.on');
      }
      if (!Number.isInteger(component.period) ||
          component.period < CLOCK_MIN_PERIOD || component.period > CLOCK_MAX_PERIOD) {
        return fail(SNAPSHOT_REASONS.INVALID_STATE, 'components.' + id + '.period');
      }
    }
    const match = GENERATED_ID.exec(id);
    if (match) {
      maxGeneratedSuffix = Math.max(maxGeneratedSuffix, Number(match[1]));
    }
  }
  const pinsSeen = new Set();
  for (const [id, wire] of Object.entries(state.wires)) {
    if (!isId(id) || !isObject(wire) || wire.id !== id) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'wires.' + id);
    }
    const wireMatch = GENERATED_ID.exec(id);
    if (wireMatch) {
      maxGeneratedSuffix = Math.max(maxGeneratedSuffix, Number(wireMatch[1]));
    }
    if (!Array.isArray(wire.points) || wire.points.length < 2) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'wires.' + id + '.points');
    }
    for (let i = 0; i < wire.points.length; i += 1) {
      if (!isPoint(wire.points[i]) || !isWireGridPoint(wire.points[i])) {
        return fail(SNAPSHOT_REASONS.INVALID_STATE, 'wires.' + id + '.points.' + i);
      }
    }
    const ends = [
      { end: wire.endA, path: 'wires.' + id + '.endA' },
      { end: wire.endB, path: 'wires.' + id + '.endB' }
    ];
    for (const item of ends) {
      const checked = validateEnd(state, item.end, item.path, definitions);
      if (!checked.ok) {
        return checked;
      }
      if (item.end && item.end.kind === 'pin') {
        const key = item.end.componentId + ':' + item.end.pinId;
        if (pinsSeen.has(key)) {
          return fail(SNAPSHOT_REASONS.INVALID_STATE, item.path + '.duplicate-pin');
        }
        pinsSeen.add(key);
      }
    }
  }

  for (const [id, frame] of Object.entries(state.frames)) {
    if (!isId(id) || !isObject(frame) || frame.id !== id) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'frames.' + id);
    }
    const frameMatch = GENERATED_ID.exec(id);
    if (frameMatch) {
      maxGeneratedSuffix = Math.max(maxGeneratedSuffix, Number(frameMatch[1]));
    }
    if (!isFiniteNumber(frame.x) || !isFiniteNumber(frame.y) ||
        !isFiniteNumber(frame.w) || !isFiniteNumber(frame.h) ||
        frame.w < 0 || frame.h < 0) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'frames.' + id + '.rect');
    }
    if (typeof frame.color !== 'string' || typeof frame.label !== 'string') {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'frames.' + id + '.style');
    }
  }

  if (state.nextId <= maxGeneratedSuffix) {
    return fail(SNAPSHOT_REASONS.INVALID_STATE, 'state.nextId.collision');
  }

  const built = buildNets(state, { definitions, includeBarePins });
  for (const net of built.nets) {
    if (net.driverPins.length > 1) {
      return fail(SNAPSHOT_REASONS.INVALID_STATE, 'nets.second-driver');
    }
  }
  return { ok: true, built };
}

function expectedPinKeys(state, definitions) {
  const keys = [];
  for (const [id, component] of Object.entries(state.components)) {
    for (const pin of componentPins(component, definitions) || []) {
      keys.push(id + ':' + pin.id);
    }
  }
  return keys;
}

function expectedInputKeys(state, definitions) {
  const keys = [];
  for (const [id, component] of Object.entries(state.components)) {
    for (const pin of componentPins(component, definitions) || []) {
      if (pin.dir === 'in') {
        keys.push(id + ':' + pin.id);
      }
    }
  }
  return keys;
}


function validateDriver(state, driver, key, definitions) {
  if (driver === null) {
    return { ok: true };
  }
  if (typeof driver !== 'string') {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'inputDrivers.' + key);
  }
  const split = driver.lastIndexOf(':');
  if (split <= 0 || split === driver.length - 1) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'inputDrivers.' + key);
  }
  const componentId = driver.slice(0, split);
  const pinId = driver.slice(split + 1);
  const component = state.components[componentId];
  if (!component) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'inputDrivers.' + key);
  }
  const pin = pinDefinition(component, pinId, definitions);
  if (!pin || pin.dir !== 'out') {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'inputDrivers.' + key);
  }
  return { ok: true };
}

function validateCycle(cycle) {
  if (!isObject(cycle) ||
      !Number.isInteger(cycle.startRound) || cycle.startRound < 0 ||
      !Number.isInteger(cycle.period) || cycle.period < 1) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'cycle');
  }
  return { ok: true };
}

function validateEvaluation(evaluation, state, built, options) {
  const definitions = options && options.definitions;
  const externalInputs = (options && options.externalInputs) || [];
  if (!isObject(evaluation)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'evaluation');
  }
  if (evaluation.ok !== true) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'evaluation.ok');
  }
  if (!STATUSES.has(evaluation.status)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'evaluation.status');
  }

  const componentIds = Object.keys(state.components);
  if (!sameKeys(evaluation.componentTypes, componentIds)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'componentTypes');
  }

  const outputIds = [];
  const lampIds = [];
  const customIds = [];
  for (const id of componentIds) {
    const type = state.components[id].type;
    if (OUTPUT_TYPES.has(type)) {
      outputIds.push(id);
    } else if (type === 'LAMP') {
      lampIds.push(id);
    } else if (type === 'CUSTOM') {
      customIds.push(id);
    }
  }

  if (!sameKeys(evaluation.componentOutput, outputIds)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'componentOutput');
  }
  for (const id of componentIds) {
    const component = state.components[id];
    if (evaluation.componentTypes[id] !== component.type) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'componentTypes.' + id);
    }
    if (OUTPUT_TYPES.has(component.type) && !isBit(evaluation.componentOutput[id])) {
      return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'componentOutput.' + id);
    }
    if (component.type === 'CUSTOM') {
      for (const pin of componentPins(component, definitions) || []) {
        if (pin.dir === 'out' && !isBit(evaluation.pinValue[id + ':' + pin.id])) {
          return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'pinValue.' + id + ':' + pin.id);
        }
      }
    }
    if (component.type === 'CONST1' && evaluation.componentOutput[id] !== 1) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'componentOutput.' + id);
    }
    if ((component.type === 'TOGGLE' || component.type === 'BUTTON' ||
         component.type === 'CLOCK') &&
        evaluation.componentOutput[id] !== (component.on ? 1 : 0)) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'componentOutput.' + id);
    }
  }

  const pinKeys = expectedPinKeys(state, definitions);
  if (!sameKeys(evaluation.pinValue, pinKeys)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'pinValue');
  }
  for (const key of pinKeys) {
    if (!isBit(evaluation.pinValue[key])) {
      return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'pinValue.' + key);
    }
  }
  for (const id of outputIds) {
    if (evaluation.pinValue[id + ':out'] !== evaluation.componentOutput[id]) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'pinValue.' + id + ':out');
    }
  }

  const inputKeys = expectedInputKeys(state, definitions);
  if (!sameKeys(evaluation.inputDrivers, inputKeys)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'inputDrivers');
  }
  if (!sameKeys(evaluation.inputConnections, inputKeys)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'inputConnections');
  }
  const netsById = new Map(built.nets.map(net => [net.id, net]));
  const connectionByNet = new Map(built.nets.map(net => [net.id, netConnectionSignature(state, net)]));
  const externalByNet = new Map();
  for (const entry of externalInputs) {
    const netId = bindingNetId(built, entry.binding);
    if (netId !== undefined) {
      externalByNet.set(netId, entry);
    }
  }
  for (const key of inputKeys) {
    const driver = evaluation.inputDrivers[key];
    const netId = built.netIdOfPin[key];
    const external = netId === undefined ? null : externalByNet.get(netId);
    if (external) {
      const expectedExternal = 'external:' + external.portId;
      if (driver !== expectedExternal ||
          evaluation.inputConnections[key] !== expectedExternal ||
          evaluation.pinValue[key] !== (external.value === 1 ? 1 : 0)) {
        return fail(SNAPSHOT_REASONS.INCONSISTENT, 'inputDrivers.' + key);
      }
      continue;
    }
    const checked = validateDriver(state, driver, key, definitions);
    if (!checked.ok) {
      return checked;
    }
    const net = netId === undefined ? null : netsById.get(netId);
    const expectedDriver = net && net.driverPins.length === 1
      ? net.driverPins[0].componentId + ':' + net.driverPins[0].pinId
      : null;
    if (driver !== expectedDriver) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'inputDrivers.' + key);
    }
    const expectedConnection = net ? connectionByNet.get(net.id) : null;
    if (evaluation.inputConnections[key] !== expectedConnection) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'inputConnections.' + key);
    }
    if (driver === null) {
      if (evaluation.pinValue[key] !== 0) {
        return fail(SNAPSHOT_REASONS.INCONSISTENT, 'pinValue.' + key);
      }
    } else if (evaluation.pinValue[key] !== evaluation.pinValue[driver]) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'pinValue.' + key);
    }
  }

  const netIds = built.nets.map(net => net.id);
  if (!sameKeys(evaluation.netValue, netIds)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'netValue');
  }
  for (const net of built.nets) {
    if (!isBit(evaluation.netValue[net.id])) {
      return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'netValue.' + net.id);
    }
    const driver = net.driverPins[0];
    const external = externalByNet.get(net.id);
    const expected = external
      ? (external.value === 1 ? 1 : 0)
      : driver
        ? evaluation.pinValue[driver.componentId + ':' + driver.pinId]
        : 0;
    if (evaluation.netValue[net.id] !== expected) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'netValue.' + net.id);
    }
  }

  if (!sameKeys(evaluation.lampOn, lampIds)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'lampOn');
  }
  for (const id of lampIds) {
    if (typeof evaluation.lampOn[id] !== 'boolean') {
      return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'lampOn.' + id);
    }
    if (evaluation.lampOn[id] !== (evaluation.pinValue[id + ':in'] === 1)) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'lampOn.' + id);
    }
  }

  if (customIds.length === 0) {
    if (evaluation.internal !== undefined) {
      if (!isObject(evaluation.internal) || Object.keys(evaluation.internal).length !== 0) {
        return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'internal');
      }
    }
  } else {
    if (!sameKeys(evaluation.internal, customIds)) {
      return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'internal');
    }
    for (const id of customIds) {
      const entry = evaluation.internal[id];
      const component = state.components[id];
      if (!isObject(entry) || entry.definitionId !== component.definitionId ||
          !isObject(entry.evaluation)) {
        return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'internal.' + id);
      }
      const definition = getDefinition(definitions, entry.definitionId);
      if (!definition) {
        return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'internal.' + id + '.definitionId');
      }
      const innerState = validateState(definition.circuit, {
        definitions,
        includeBarePins: true
      });
      if (!innerState.ok) {
        return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'internal.' + id + '.state');
      }
      const innerExternal = externalInputsForInstance(evaluation, id, definition);
      const innerResult = validateEvaluation(entry.evaluation, definition.circuit, innerState.built, {
        definitions,
        includeBarePins: true,
        externalInputs: innerExternal
      });
      if (!innerResult.ok) {
        return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'internal.' + id + '.' + innerResult.detail);
      }
      if (entry.evaluation.status !== 'stable' || entry.evaluation.pending.length !== 0) {
        return fail(SNAPSHOT_REASONS.INCONSISTENT, 'internal.' + id + '.status');
      }
      const innerBuilt = innerState.built;
      for (const port of outputPorts(definition)) {
        const expected = portValue(entry.evaluation, definition, port, innerBuilt);
        if (evaluation.pinValue[id + ':' + port.id] !== expected) {
          return fail(SNAPSHOT_REASONS.INCONSISTENT, 'internal.' + id + '.output.' + port.id);
        }
      }
      for (const port of inputPorts(definition)) {
        const expected = portValue(entry.evaluation, definition, port, innerBuilt);
        if (evaluation.pinValue[id + ':' + port.id] !== expected) {
          return fail(SNAPSHOT_REASONS.INCONSISTENT, 'internal.' + id + '.input.' + port.id);
        }
      }
    }
  }

  if (!Array.isArray(evaluation.pending)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'pending');
  }
  const pendingSeen = new Set();
  for (const id of evaluation.pending) {
    if (!isId(id) || !hasOwn(state.components, id) || !GATES.has(state.components[id].type)) {
      return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'pending.' + id);
    }
    if (pendingSeen.has(id)) {
      return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'pending.duplicate');
    }
    pendingSeen.add(id);
  }

  if (evaluation.status === 'stable') {
    if (evaluation.pending.length !== 0) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'pending.stable');
    }
    if (evaluation.cycle !== undefined && evaluation.cycle !== null) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'cycle.stable');
    }
  } else if (evaluation.status === 'oscillating') {
    if (evaluation.pending.length === 0) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'pending.oscillating');
    }
    const cycle = validateCycle(evaluation.cycle);
    if (!cycle.ok) {
      return cycle;
    }
  } else {
    if (evaluation.pending.length === 0) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'pending.budget');
    }
    if (evaluation.cycle !== undefined && evaluation.cycle !== null) {
      return fail(SNAPSHOT_REASONS.INCONSISTENT, 'cycle.budget');
    }
  }

  if (evaluation.trace !== undefined && !Array.isArray(evaluation.trace)) {
    return fail(SNAPSHOT_REASONS.INVALID_EVALUATION, 'trace');
  }
  return { ok: true };
}

// 构造独立快照；版本号和 view 留给 M6-S2 的 Session 记录。
// 本函数只负责构造，不验证；写入持久化前必须调用 validateSnapshot 或
// prepareSnapshotRestore。
export function createSnapshot(state, evaluation) {
  return clone({ state, evaluation });
}

// 只读验证，不调用 evaluateDynamic，不修改 snapshot。
export function validateSnapshot(snapshot, options) {
  if (!isObject(snapshot) ||
      !hasOwn(snapshot, 'state') ||
      !hasOwn(snapshot, 'evaluation')) {
    return fail(SNAPSHOT_REASONS.INVALID_SNAPSHOT, 'snapshot');
  }
  const stateResult = validateState(snapshot.state, options);
  if (!stateResult.ok) {
    return stateResult;
  }
  const evaluationResult = validateEvaluation(snapshot.evaluation, snapshot.state, stateResult.built, options);
  if (!evaluationResult.ok) {
    return evaluationResult;
  }
  return { ok: true, state: snapshot.state, evaluation: snapshot.evaluation };
}

// 供应用层在验证后直接恢复；返回引用来自调用方提供的 snapshot。
// 调用方获得这些引用的所有权，不应在同一快照上继续原地编辑。
export function prepareSnapshotRestore(snapshot, options) {
  return validateSnapshot(snapshot, options);
}
