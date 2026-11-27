// 封装草稿的纯数据操作；不依赖 DOM 或应用实例。
import { CELL, slotCount, slotOffset } from "../core/geometry.js";
import { evaluateDynamic } from "../core/dynamic.js";
import { buildNets } from "../core/nets.js";
import { bindingNetId, bindingValue } from "../core/ports.js";

const draftRuntimes = new WeakMap();

export function invalidateDraftRuntime(state) {
  draftRuntimes.delete(state);
}

function cachedDraftRuntime(draft) {
  let runtime = draftRuntimes.get(draft.state);
  if (!runtime || runtime.library !== draft.library) {
    runtime = { library: draft.library };
    draftRuntimes.set(draft.state, runtime);
  }
  // 工作台的端口数组与字段可能原地修改。名称和槽位不影响求值。
  const bindings = JSON.stringify(draft.ports.map(({ id, direction, binding }) => [
    id, direction, binding?.kind, binding?.componentId, binding?.pinId, binding?.wireId
  ]));
  if (runtime.bindings !== bindings) {
    runtime.bindings = bindings;
    runtime.pausedInputs = null;
    runtime.testValues = null;
  }
  return runtime;
}

function draftNets(draft, runtime) {
  if (!runtime.built) {
    runtime.built = buildNets(draft.state, { definitions: draft.library, includeBarePins: true });
    runtime.netsById = new Map(runtime.built.nets.map(net => [net.id, net]));
  }
  return runtime.built;
}

function pausedDraftInputs(draft, runtime, inputs) {
  if (runtime.pausedInputs) return runtime.pausedInputs;
  const reasons = Object.create(null);
  if (inputs.length) {
    const built = draftNets(draft, runtime);
    const inputsByNet = new Map();
    for (const port of inputs) {
      const net = runtime.netsById.get(bindingNetId(built, port.binding));
      if (!net) {
        reasons[port.id] = '管脚绑定已失效';
      } else if (net.driverPins.length) {
        reasons[port.id] = '内部 Net 已有驱动';
      } else {
        const netInputs = inputsByNet.get(net.id);
        if (netInputs) netInputs.push(port.id);
        else inputsByNet.set(net.id, [port.id]);
      }
    }
    for (const portIds of inputsByNet.values()) {
      if (portIds.length < 2) continue;
      for (const portId of portIds) reasons[portId] = '多个测试输入绑定到同一个内部 Net';
    }
  }
  runtime.pausedInputs = Object.freeze(reasons);
  return runtime.pausedInputs;
}

function draftInputValue(draft, portId) {
  return draft.inputs && Object.prototype.hasOwnProperty.call(draft.inputs, portId) &&
    draft.inputs[portId] ? 1 : 0;
}

function draftOutputValues(draft, runtime) {
  const evaluation = draft.evaluation;
  const values = draft.ports.filter(port => port.direction === 'out').map(({ id, binding }) => {
    const pinKey = binding?.kind === 'pin'
      ? binding.componentId + ':' + binding.pinId
      : null;
    if (pinKey && evaluation?.pinValue &&
        Object.prototype.hasOwnProperty.call(evaluation.pinValue, pinKey)) {
      return [id, bindingValue(evaluation, null, binding)];
    }
    return [id, bindingValue(evaluation, draftNets(draft, runtime), binding)];
  });
  return Object.fromEntries(values);
}

export function draftTestValues(draft) {
  const runtime = cachedDraftRuntime(draft);
  const ports = draft.ports.filter(port => port.direction === 'in');
  const bits = ports.map(port => draftInputValue(draft, port.id));
  const inputBits = bits.join('');
  if (runtime.testValues && runtime.evaluation === draft.evaluation && runtime.inputBits === inputBits) {
    return runtime.testValues;
  }
  runtime.evaluation = draft.evaluation;
  runtime.inputBits = inputBits;
  runtime.testValues = Object.freeze({
    inputs: Object.freeze(Object.fromEntries(ports.map((port, index) => [port.id, bits[index]]))),
    outputs: Object.freeze(draftOutputValues(draft, runtime)),
    pausedInputs: pausedDraftInputs(draft, runtime, ports)
  });
  return runtime.testValues;
}

export function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

export function rootDraftOf(draft) {
  let root = draft;
  while (root && root.parent) root = root.parent;
  return root;
}

export function draftChainOf(draft) {
  const chain = [];
  let current = draft;
  while (current) {
    chain.push(current);
    current = current.parent;
  }
  return chain.reverse();
}

export function draftDisplayName(draft) {
  return draft.name || (draft.definitionId ? draft.definitionId : '新元件');
}

export function draftPathHasDefinition(draft, definitionId) {
  return draftChainOf(draft).some(function (item) {
    return item.definitionId === definitionId;
  });
}

export function draftRuntimeOptions(draft) {
  const inputs = draft.ports.filter(port => port.direction === 'in');
  const paused = pausedDraftInputs(draft, cachedDraftRuntime(draft), inputs);
  return {
    definitions: draft.library,
    includeBarePins: true,
    externalInputs: inputs.filter(port => !paused[port.id]).map(port => ({
      portId: port.id,
      binding: port.binding,
      value: draftInputValue(draft, port.id)
    }))
  };
}

export function evaluateDraft(draft, previous) {
  return evaluateDynamic(draft.state, previous, undefined, draftRuntimeOptions(draft));
}

export function resolvePortNet(draft, binding) {
  const built = buildNets(draft.state, {
    definitions: draft.library,
    includeBarePins: true
  });
  const netId = bindingNetId(built, binding);
  return {
    built,
    netId,
    net: netId === undefined ? null : built.nets.find(function (net) { return net.id === netId; })
  };
}

const annotationSides = {
  in: ['left', 'top', 'bottom', 'right'],
  out: ['right', 'bottom', 'top', 'left']
};

export function freeSlotFor(draft, direction) {
  const used = new Set();
  for (const port of draft.ports) {
    if (port.side && Number.isInteger(port.slot)) {
      used.add(port.side + ':' + port.slot);
    }
  }
  const defaultSides = annotationSides[direction] || ['top', 'bottom', 'left', 'right'];
  const cursor = draft.portPlacementCursors?.[direction];
  const preferredSide = cursor?.side;
  const sides = preferredSide
    ? [preferredSide, ...defaultSides.filter(side => side !== preferredSide)]
    : defaultSides;
  for (const side of sides) {
    const count = slotCount(draft.rows, draft.cols, side);
    const horizontal = side === 'top' || side === 'bottom';
    const edgeLength = (horizontal ? draft.cols : draft.rows) * CELL;
    const cursorPoint = side === preferredSide && slotOffset(draft.rows, draft.cols, side, cursor.slot);
    const cursorPosition = cursorPoint && (horizontal ? cursorPoint.x : cursorPoint.y);
    let firstFree = null;
    let firstPosition = Infinity;
    for (let slot = 0; slot < count; slot += 1) {
      if (used.has(side + ':' + slot)) continue;
      if (!direction) return { side, slot };
      // 格子交界槽位的编号排在常规槽位之后，排位按预览坐标。
      const { x, y } = slotOffset(draft.rows, draft.cols, side, slot);
      let position = horizontal ? x : y;
      if (cursorPoint && position <= cursorPosition) position += edgeLength;
      if (position < firstPosition) {
        firstPosition = position;
        firstFree = { side, slot };
      }
    }
    if (firstFree) return firstFree;
  }
  return null;
}

export function normalizeDraftPorts(draft) {
  const used = new Set();
  for (const port of draft.ports) {
    const valid = port.side && Number.isInteger(port.slot) &&
      slotOffset(draft.rows, draft.cols, port.side, port.slot) &&
      !used.has(port.side + ':' + port.slot);
    if (valid) {
      used.add(port.side + ':' + port.slot);
      continue;
    }
    const slot = freeSlotFor({ rows: draft.rows, cols: draft.cols, ports: draft.ports.filter(function (item) {
      return item !== port && item.side && Number.isInteger(item.slot);
    }) });
    if (slot) {
      port.side = slot.side;
      port.slot = slot.slot;
      used.add(slot.side + ':' + slot.slot);
    } else {
      port.side = null;
      port.slot = null;
    }
  }
}

export function validateDraftPorts(draft) {
  const used = new Set();
  for (const port of draft.ports) {
    if (!port.name || !port.name.trim()) return { ok: false, reason: '管脚名称不能为空' };
    if (port.direction !== 'in' && port.direction !== 'out') return { ok: false, reason: '管脚方向无效' };
    if (!port.side || !Number.isInteger(port.slot) ||
        !slotOffset(draft.rows, draft.cols, port.side, port.slot)) {
      return { ok: false, reason: '管脚槽位无效' };
    }
    const key = port.side + ':' + port.slot;
    if (used.has(key)) return { ok: false, reason: '槽位重复' };
    used.add(key);
  }
  return { ok: true };
}

export function captureDraftBaseline(draft) {
  return {
    name: draft.name,
    icon: draft.icon || null,
    rows: draft.rows,
    cols: draft.cols,
    state: cloneValue(draft.state),
    ports: cloneValue(draft.ports)
  };
}

// 运行状态与工作区引用必须原样恢复；只有瞬态 overlay 捕获时复制。
const WORKSPACE_FIELDS = ['state', 'evaluation', 'view', 'selection', 'mode', 'placeType', 'tool', 'placeDefinitionId', 'overlay'];
export function captureEditorWorkspace(app) {
  const workspace = {};
  for (const key of WORKSPACE_FIELDS) workspace[key] = key === 'overlay' ? cloneValue(app[key]) : app[key];
  return workspace;
}
export function restoreEditorWorkspace(app, workspace) {
  for (const key of WORKSPACE_FIELDS) app[key] = workspace[key];
}
export function draftHasChanges(draft, currentName = draft && draft.name) {
  if (!draft || draft.readOnly || !draft.baseline) return false;
  const baseline = draft.baseline;
  return currentName !== baseline.name ||
    (draft.icon || null) !== (baseline.icon || null) ||
    draft.rows !== baseline.rows || draft.cols !== baseline.cols ||
    JSON.stringify(draft.state) !== JSON.stringify(baseline.state) ||
    JSON.stringify(draft.ports) !== JSON.stringify(baseline.ports);
}


export function createDraftDefinitionCandidate(draft, id, name, initialEvaluation) {
  return {
    id,
    name,
    icon: draft.icon || null,
    circuit: cloneValue(draft.state),
    ports: cloneValue(draft.ports),
    size: { rows: draft.rows, cols: draft.cols },
    initialEvaluation
  };
}
