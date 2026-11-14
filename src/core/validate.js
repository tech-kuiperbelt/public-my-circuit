// 职责：编辑前的合法性校验（引脚、重合、环、多驱动、几何）；纯函数，不修改 state。
import {
  COMPONENT_PINS,
  boundsOverlap,
  componentBounds,
  componentPins,
  pinWorld
} from './geometry.js';
import { buildNets } from './nets.js';
import { addWire } from './state.js';
import { REASONS } from './reasons.js';

function ok() {
  return { ok: true };
}

function reject(reason) {
  return { ok: false, reason };
}

function hasType(type, definitionId) {
  if (type === 'CUSTOM') {
    return typeof definitionId === 'string' && definitionId.length > 0;
  }
  return Object.prototype.hasOwnProperty.call(COMPONENT_PINS, type);
}

function eachWireEnd(wire, fn) {
  if (wire.endA) fn(wire.endA);
  if (wire.endB) fn(wire.endB);
}

// 某个引脚是否已经接入任何一根线。
export function isPinConnected(state, componentId, pinId) {
  const wireIds = Object.keys(state.wires);
  for (const wireId of wireIds) {
    let found = false;
    eachWireEnd(state.wires[wireId], function (end) {
      if (end.kind === 'pin' && end.componentId === componentId && end.pinId === pinId) {
        found = true;
      }
    });
    if (found) {
      return true;
    }
  }
  return false;
}

// 找出接在指定引脚上的导线与端侧；正常状态至多一条。
export function pinWireEnd(state, componentId, pinId) {
  for (const wireId of Object.keys(state.wires)) {
    const wire = state.wires[wireId];
    for (const side of ['A', 'B']) {
      const end = side === 'A' ? wire.endA : wire.endB;
      if (end && end.kind === 'pin' && end.componentId === componentId && end.pinId === pinId) {
        return { wireId, side };
      }
    }
  }
  return null;
}

// 元件是否有任何引脚接了线（判定“已接线对象”）。
export function componentHasWires(state, componentId) {
  const wireIds = Object.keys(state.wires);
  for (const wireId of wireIds) {
    let found = false;
    eachWireEnd(state.wires[wireId], function (end) {
      if (end.kind === 'pin' && end.componentId === componentId) {
        found = true;
      }
    });
    if (found) {
      return true;
    }
  }
  return false;
}

function placementCheck(state, type, cx, cy, rotation, ignoreId, definitionId, definitionOptions = {}) {
  if (!hasType(type, definitionId)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (!Number.isInteger(cx) || !Number.isInteger(cy)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  const ids = Object.keys(state.components);
  const probe = {
    type,
    cx,
    cy,
    rotation: rotation || 0,
    ...(type === 'CUSTOM' ? { definitionId } : {})
  };
  const probePins = componentPins(probe, definitionOptions.definitions);
  if (!probePins) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const probeBounds = componentBounds(probe, definitionOptions.definitions);

  for (const id of ids) {
    if (id === ignoreId) {
      continue;
    }
    const component = state.components[id];
    if (boundsOverlap(componentBounds(component, definitionOptions.definitions), probeBounds)) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
  }

  for (const id of ids) {
    if (id === ignoreId) {
      continue;
    }
    const component = state.components[id];
    const defs = componentPins(component, definitionOptions.definitions) || [];
    for (const def of defs) {
      const world = pinWorld(component, def.id, definitionOptions.definitions);
      for (const probePin of probePins) {
        const probeWorld = pinWorld(probe, probePin.id, definitionOptions.definitions);
        if (world.x === probeWorld.x && world.y === probeWorld.y) {
          return reject(REASONS.PIN_COINCIDENT);
        }
      }
    }
  }

  return ok();
}

// 目标格是否可放置某个元件（rotation 默认为 0）。
export function checkPlacement(state, type, cx, cy, options) {
  const opts = options || {};
  return placementCheck(state, type, cx, cy, opts.rotation || 0, null, opts.definitionId, opts);
}

// 内部使用：按给定 rotation 校验放置，并忽略 ignoreId 这个元件自身（move/rotate）。
export function checkPlacementIgnoring(state, type, cx, cy, rotation, ignoreId, options) {
  const opts = options || {};
  return placementCheck(state, type, cx, cy, rotation, ignoreId, opts.definitionId, opts);
}

// 用现有元件对象校验移动/旋转后的位置，保留 definitionId。
export function checkComponentPlacement(state, component, cx, cy, rotation, ignoreId, definitionOptions = {}) {
  return placementCheck(
    state,
    component.type,
    cx,
    cy,
    rotation === undefined ? component.rotation || 0 : rotation,
    ignoreId,
    component.definitionId
  , { definitions: definitionOptions.definitions });
}

function endNetId(built, end) {
  if (!end) {
    return undefined;
  }
  if (end.kind === 'pin') {
    return built.netIdOfPin[end.componentId + ':' + end.pinId];
  }
  if (end.kind === 'junction') {
    return built.netIdOfWire[end.wireId];
  }
  return undefined;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// 纯拓扑判定：不涉及几何/布线。命中即按 a→e 顺序返回。
export function checkConnect(state, endA, endB, definitionOptions = {}) {
  const ends = [endA, endB];

  for (const end of ends) {
    if (end && end.kind === 'pin' && isPinConnected(state, end.componentId, end.pinId)) {
      return reject(REASONS.PIN_ALREADY_CONNECTED);
    }
  }

  if (
    endA &&
    endB &&
    endA.kind === 'pin' &&
    endB.kind === 'pin' &&
    endA.componentId === endB.componentId &&
    endA.pinId === endB.pinId
  ) {
    return reject(REASONS.PIN_COINCIDENT);
  }

  const current = buildNets(state, { definitions: definitionOptions.definitions });
  const netA = endNetId(current, endA);
  const netB = endNetId(current, endB);
  if (netA !== undefined && netB !== undefined && netA === netB) {
    return reject(REASONS.PURE_WIRE_LOOP);
  }

  const draft = clone(state);
  const probeId = addWire(draft, [], clone(endA), clone(endB));
  const next = buildNets(draft, { definitions: definitionOptions.definitions });
  const merged = next.nets.find(function (net) {
    return net.wireIds.indexOf(probeId) !== -1;
  });
  if (merged && merged.driverPins.length >= 2) {
    return reject(REASONS.SECOND_DRIVER);
  }

  // 反馈环是否可接受由运行时提交阶段按求值策略判断，结构层不拒绝。
  return ok();
}
