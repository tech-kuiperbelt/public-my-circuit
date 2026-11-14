// 封装草稿的纯数据操作；不依赖 DOM 或应用实例。
import { slotCount, slotOffset } from "../core/geometry.js";
import { evaluateDynamic } from "../core/dynamic.js";
import { buildNets } from "../core/nets.js";
import { bindingNetId } from "../core/ports.js";

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

export function draftExternalInputs(draft) {
  return draft.ports.filter(function (port) {
    return port.direction === 'in';
  }).map(function (port) {
    return {
      portId: port.id,
      binding: port.binding,
      value: draft.inputs[port.id] ? 1 : 0
    };
  });
}

export function evaluateDraft(draft, previous) {
  return evaluateDynamic(draft.state, previous, undefined, {
    definitions: draft.library,
    includeBarePins: true,
    externalInputs: draftExternalInputs(draft)
  });
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

export function portNetId(draft, port) {
  return resolvePortNet(draft, port.binding).netId;
}

export function freeSlotFor(draft) {
  const used = new Set();
  for (const port of draft.ports) {
    if (port.side && Number.isInteger(port.slot)) {
      used.add(port.side + ':' + port.slot);
    }
  }
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const count = slotCount(draft.rows, draft.cols, side);
    for (let slot = 0; slot < count; slot += 1) {
      if (!used.has(side + ':' + slot)) {
        return { side, slot };
      }
    }
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
