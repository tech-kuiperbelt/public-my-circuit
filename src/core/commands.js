// 职责：编辑命令管线（命令 → 校验 → 应用 → 重算 → 渲染）。
// 每个命令先深拷贝 state，在副本上修改并校验；失败只返回原因，绝不触碰入参。
import { addComponent, removeComponent, addWire, addFrame } from './state.js';
import { FRAME_DEFAULT_COLOR, FRAME_DEFAULT_LABEL } from './entities.js';
import { normalizeClockPeriod, resetClockValues } from './clock.js';
import { REASONS } from './reasons.js';
import { copyGrid, copySourceOrigin } from './copy-layout.js';
import {
  CELL,
  WIRE_GRID,
  boundsOverlap,
  componentBounds,
  componentPins,
  isWireGridPoint,
  pinWorld,
  pointInBounds,
  polylineOverlapsComponentEdge,
  segmentOverlapsBoundsEdge,
  segmentOverlapsComponentEdge,
  snapToWireGrid
} from './geometry.js';
import { buildNets } from './nets.js';
import {
  pointOnPolylineInterior,
  pointOnSegmentInterior,
  polylinePoints,
  segmentDirection,
  segmentDragAxis,
  simplify,
  translateSegment
} from './wire.js';
import { route, validateCrossings, buildWireMeta } from './router.js';
import {
  checkPlacement,
  checkComponentPlacement,
  checkConnect,
  isPinConnected
} from './validate.js';

function clone(state) {
  return JSON.parse(JSON.stringify(state));
}

function reject(reason) {
  return { ok: false, reason };
}

function normalizeRotation(value) {
  return ((value % 4) + 4) % 4;
}

export function placeComponent(state, type, cx, cy, options) {
  const opts = options || {};
  const draft = clone(state);
  const check = checkPlacement(draft, type, cx, cy, opts);
  if (!check.ok) {
    return reject(check.reason);
  }
  const id = addComponent(draft, type, cx, cy, opts);
  if (type === 'CUSTOM') {
    draft.components[id].definitionId = opts.definitionId;
  }

  // 从元件栏放置时，新引脚若正好落在其它导线的 free 端点上，自动接上。
  // 与移动元件共用同一接管规则；接管属于拓扑变化，不能再用 skipA 跳过求值。
  const autoAttached = autoAttachFreeEnds(draft, [id], { definitions: opts.definitions });
  if (autoAttached.size > 0) {
    for (const wireId of autoAttached) {
      const checkWire = checkMovedWire(draft, wireId, draft.wires[wireId].points, { definitions: opts.definitions });
      if (!checkWire.ok) {
        return reject(REASONS.ILLEGAL_GEOMETRY);
      }
    }
    if (hasSecondDriver(draft, { definitions: opts.definitions })) {
      return reject(REASONS.SECOND_DRIVER);
    }
  }

  // 新引脚仍压在线身/多个 free 端点上时保持歧义：与移动元件一致，拒绝放置。
  for (const def of componentPins(draft.components[id], { definitions: opts.definitions }) || []) {
    const point = pinWorld(draft.components[id], def.id, opts.definitions);
    if (pinHitsForeignWire(draft, id, def.id, point)) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
  }

  return autoAttached.size > 0
    ? { ok: true, state: draft, id }
    : { ok: true, state: draft, id, skipA: true };
}

export function removeComponentCommand(state, id) {
  const draft = clone(state);
  if (!draft.components[id]) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  removeComponent(draft, id);
  return { ok: true, state: draft };
}

export function removeComponentsCommand(state, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const draft = clone(state);
  let removed = 0;
  for (const id of ids) {
    if (removeComponent(draft, id)) {
      removed += 1;
    }
  }
  if (removed === 0) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  return { ok: true, state: draft };
}

function detachJunctionFromSet(end, deletedWireIds) {
  if (end && end.kind === 'junction' && deletedWireIds.has(end.wireId)) {
    return { kind: 'free' };
  }
  return end;
}

function normalizeFrameColor(value) {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase()
    : FRAME_DEFAULT_COLOR;
}

function normalizeFrameLabel(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || FRAME_DEFAULT_LABEL;
}

// 分组框创建：世界坐标矩形，不参与元件/导线碰撞。
export function addFrameCommand(state, rect, opts) {
  const box = rect || {};
  const x = box.x;
  const y = box.y;
  const w = box.w;
  const h = box.h;
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(w) ||
    !Number.isFinite(h) ||
    w <= 0 ||
    h <= 0
  ) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const options = opts || {};
  const draft = clone(state);
  const id = addFrame(draft, x, y, w, h, {
    color: normalizeFrameColor(options.color),
    label: normalizeFrameLabel(options.label)
  });
  return { ok: true, state: draft, id, geometryOnly: true };
}

export function updateFrameCommand(state, id, values) {
  const draft = clone(state);
  const frame = draft.frames[id];
  if (!frame) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const patch = values || {};
  if (patch.color !== undefined) {
    frame.color = normalizeFrameColor(patch.color);
  }
  if (patch.label !== undefined) {
    frame.label = normalizeFrameLabel(patch.label);
  }
  return { ok: true, state: draft, geometryOnly: true };
}

export function moveFrameCommand(state, id, dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const draft = clone(state);
  const frame = draft.frames[id];
  if (!frame) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  frame.x += dx;
  frame.y += dy;
  return { ok: true, state: draft, geometryOnly: true };
}

export function removeFrameCommand(state, id) {
  const draft = clone(state);
  if (!draft.frames[id]) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  delete draft.frames[id];
  return { ok: true, state: draft, geometryOnly: true };
}

// 框选批量删除：元件、导线与分组框可同时删除；未选中的导线保留并拆开连接。
export function removeSelectionCommand(state, componentIds, wireIds, frameIds) {
  const components = Array.isArray(componentIds) ? componentIds : [];
  const wires = Array.isArray(wireIds) ? wireIds : [];
  const frames = Array.isArray(frameIds) ? frameIds : [];
  if (components.length === 0 && wires.length === 0 && frames.length === 0) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const draft = clone(state);
  const deletedWireIds = new Set();
  for (const id of wires) {
    if (draft.wires[id]) {
      delete draft.wires[id];
      deletedWireIds.add(id);
    }
  }
  for (const id of Object.keys(draft.wires)) {
    const wire = draft.wires[id];
    wire.endA = detachJunctionFromSet(wire.endA, deletedWireIds);
    wire.endB = detachJunctionFromSet(wire.endB, deletedWireIds);
  }
  let removedComponents = 0;
  for (const id of components) {
    if (removeComponent(draft, id)) {
      removedComponents += 1;
    }
  }
  let removedFrames = 0;
  for (const id of frames) {
    if (draft.frames[id]) {
      delete draft.frames[id];
      removedFrames += 1;
    }
  }
  if (deletedWireIds.size === 0 && removedComponents === 0 && removedFrames === 0) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  return { ok: true, state: draft };
}

// 复制选中的元件布局：只复制元件（不复制导线），目标块必须完全放得下。
// 旧接口仅做几何预检；自动接线后的校验由命令执行，预检通过不保证提交成功。
// snapshot: [{ type, definitionId?, cx, cy, rotation, on }]
export function previewCopyComponents(state, snapshot, anchorCx, anchorCy, definitionOptions = {}) {
  if (
    !Array.isArray(snapshot) ||
    snapshot.length === 0 ||
    !Number.isInteger(anchorCx) ||
    !Number.isInteger(anchorCy)
  ) {
    return reject(REASONS.COPY_BLOCKED);
  }
  for (const item of snapshot) {
    if (!componentPins(item, definitionOptions.definitions) || !Number.isInteger(item.cx) || !Number.isInteger(item.cy)) {
      return reject(REASONS.COPY_BLOCKED);
    }
  }
  const origin = copySourceOrigin({ components: snapshot });
  const dx = anchorCx - origin.x / CELL;
  const dy = anchorCy - origin.y / CELL;
  const targets = snapshot.map(function (item) {
    return {
      type: item.type,
      definitionId: item.definitionId,
      cx: item.cx + dx,
      cy: item.cy + dy,
      rotation: item.rotation || 0,
      on: item.on,
      period: item.period
    };
  });

  const existingPins = componentPinKeys(state, definitionOptions);
  const existingBounds = componentBoundsList(state, definitionOptions);
  const existingWires = Object.values(state.wires).map(function (wire) {
    return { wire, bounds: polylineBounds(wire?.points || []) };
  });
  const targetPins = new Set();
  let duplicateTargetPin = false;
  for (const target of targets) {
    const probe = {
      type: target.type,
      definitionId: target.definitionId,
      cx: target.cx,
      cy: target.cy,
      rotation: target.rotation
    };
    const targetBounds = componentBounds(probe, definitionOptions.definitions);
    for (const bounds of existingBounds) {
      if (boundsOverlap(bounds, targetBounds)) {
        return { ok: false, reason: REASONS.COPY_BLOCKED, targets };
      }
    }
    for (const def of componentPins(probe, definitionOptions.definitions) || []) {
      const point = pinWorld(probe, def.id, definitionOptions.definitions);
      const key = pointKeyOf(point);
      if (existingPins.has(key)) {
        return { ok: false, reason: REASONS.COPY_BLOCKED, targets };
      }
      // 目标引脚落在导线上：只有“唯一一个 free 端点正好与该引脚重合”时才放行，
      // 后续由 autoAttachFreeEnds 接上；线身、多个端点仍拒绝。
      if (!freeEndpointTargetAt(state, point)) {
        for (const { wire } of existingWires) {
          if (wirePassesThroughPoint(wire, point)) {
            return { ok: false, reason: REASONS.COPY_BLOCKED, targets };
          }
        }
      }
      if (targetPins.has(key)) duplicateTargetPin = true;
      targetPins.add(key);
    }
    for (const { wire, bounds } of existingWires) {
      if (boundsOverlap(bounds, targetBounds) && wirePassesThroughBounds(wire, targetBounds)) {
        return { ok: false, reason: REASONS.COPY_BLOCKED, targets };
      }
    }
  }
  return duplicateTargetPin
    ? { ok: false, reason: REASONS.COPY_BLOCKED, targets }
    : { ok: true, targets, dx, dy };
}

// 按数组顺序返回新 ID，兼容旧元件快照没有源 ID 的情况。
function addCopiedComponents(draft, targets) {
  const ids = [];
  for (const target of targets) {
    const id = addComponent(draft, target.type, target.cx, target.cy, {
      rotation: target.rotation,
      on: target.on,
      period: target.period
    });
    if (target.type === 'CUSTOM') {
      draft.components[id].definitionId = target.definitionId;
    }
    ids.push(id);
  }
  return ids;
}

// 两条复制路径保留各自校验顺序，只复用自动接线之后的共同检查。
function copiedAttachmentsFailure(draft, autoAttached, definitionOptions, validation) {
  if (autoAttached.size === 0) return null;
  for (const wireId of autoAttached) {
    if (!checkMovedWire(draft, wireId, draft.wires[wireId].points, definitionOptions, validation).ok) {
      return REASONS.COPY_BLOCKED;
    }
  }
  return hasSecondDriver(draft, definitionOptions, validation?.built) ? REASONS.SECOND_DRIVER : null;
}

export function copyComponentsCommand(state, snapshot, anchorCx, anchorCy, definitionOptions = {}) {
  const preview = previewCopyComponents(state, snapshot, anchorCx, anchorCy, { definitions: definitionOptions.definitions });
  if (!preview.ok) {
    return reject(preview.reason);
  }
  const draft = clone(state);
  const ids = addCopiedComponents(draft, preview.targets);
  const autoAttached = autoAttachFreeEnds(draft, ids, { definitions: definitionOptions.definitions });
  const validation = autoAttached.size > 0 ? wireValidation(draft, definitionOptions) : null;
  const failure = copiedAttachmentsFailure(draft, autoAttached, definitionOptions, validation);
  if (failure) {
    return reject(failure);
  }
  return { ok: true, state: draft, ids };
}

// 复制选中元件 + 选中导线的完整布局。含元件时，导线端点若接未选中对象则拒绝；
// 纯导线复制（没有元件）时，外部 pin/junction 端点脱开为 free，副本成为独立悬空线。
function mapCopyEnd(end, componentMap, wireMap, dx, dy, detachExternal) {
  if (!end) {
    return { kind: 'free' };
  }
  if (end.kind === 'pin') {
    const componentId = componentMap.get(end.componentId);
    if (componentId) {
      return { kind: 'pin', componentId, pinId: end.pinId };
    }
    return detachExternal ? { kind: 'free' } : null;
  }
  if (end.kind === 'junction') {
    const wireId = wireMap.get(end.wireId);
    if (wireId) {
      return {
        kind: 'junction',
        wireId,
        point: { x: end.point.x + dx, y: end.point.y + dy }
      };
    }
    return detachExternal ? { kind: 'free' } : null;
  }
  return { kind: 'free' };
}

export function previewCopySelection(state, snapshot, anchorCx, anchorCy, definitionOptions = {}) {
  const hasSnapshot = Boolean(snapshot);
  const components = hasSnapshot && Array.isArray(snapshot.components) ? snapshot.components : [];
  const wires = hasSnapshot && Array.isArray(snapshot.wires) ? snapshot.wires : [];
  const frames = hasSnapshot && Array.isArray(snapshot.frames) ? snapshot.frames : [];
  if (
    !hasSnapshot ||
    (components.length === 0 && wires.length === 0 && frames.length === 0) ||
    !Number.isInteger(anchorCx) ||
    !Number.isInteger(anchorCy)
  ) {
    return reject(REASONS.COPY_BLOCKED);
  }
  const detachExternal = components.length === 0;
  for (const frame of frames) {
    if (
      !Number.isFinite(frame.x) ||
      !Number.isFinite(frame.y) ||
      !Number.isFinite(frame.w) ||
      !Number.isFinite(frame.h) ||
      frame.w <= 0 ||
      frame.h <= 0
    ) {
      return reject(REASONS.COPY_BLOCKED);
    }
  }

  let componentPreview = { ok: true, targets: [], dx: 0, dy: 0 };
  let dxCells = 0;
  let dyCells = 0;
  if (components.length > 0) {
    componentPreview = previewCopyComponents(state, components, anchorCx, anchorCy, { definitions: definitionOptions.definitions });
    if (!componentPreview.ok) {
      return {
        ok: false,
        reason: componentPreview.reason,
        components: componentPreview.targets || [],
        wires: [],
        frames: []
      };
    }
    dxCells = componentPreview.dx;
    dyCells = componentPreview.dy;
  }

  let dx = dxCells * CELL;
  let dy = dyCells * CELL;
  if (components.length === 0) {
    const origin = copySourceOrigin(snapshot);
    if (!origin) {
      return reject(REASONS.COPY_BLOCKED);
    }
    const grid = copyGrid(snapshot);
    dx = anchorCx * grid - origin.x;
    dy = anchorCy * grid - origin.y;
  }


  const shiftedFrames = frames.map(function (frame) {
    return {
      x: frame.x + dx,
      y: frame.y + dy,
      w: frame.w,
      h: frame.h,
      color: frame.color,
      label: frame.label
    };
  });
  const fail = function (reason, componentTargets, wirePoints) {
    return {
      ok: false,
      reason,
      components: componentTargets || componentPreview.targets || [],
      wires: wirePoints || [],
      frames: shiftedFrames
    };
  };

  const sourceComponentIds = new Set(components.map(function (component) {
    return component.id;
  }));
  const sourceWireIds = new Set(wires.map(function (wire) {
    return wire.id;
  }));
  if (!detachExternal) {
    for (const wire of wires) {
      for (const end of [wire.endA, wire.endB]) {
        if (!end) {
          continue;
        }
        if (end.kind === 'pin' && !sourceComponentIds.has(end.componentId)) {
          return fail(REASONS.COPY_BLOCKED, componentPreview.targets, []);
        }
        if (end.kind === 'junction' && !sourceWireIds.has(end.wireId)) {
          return fail(REASONS.COPY_BLOCKED, componentPreview.targets, []);
        }
      }
    }
  }

  const shiftedWires = wires.map(function (wire) {
    return {
      id: wire.id,
      points: (wire.points || []).map(function (point) {
        return { x: point.x + dx, y: point.y + dy };
      })
    };
  });
  const shiftedById = new Map();
  for (const wire of shiftedWires) {
    shiftedById.set(wire.id, wire.points);
  }

  const draft = clone(state);
  const componentMap = new Map();
  const copiedComponentIds = addCopiedComponents(draft, componentPreview.targets);
  components.forEach(function (component, index) {
    componentMap.set(component.id, copiedComponentIds[index]);
  });
  const frameIds = [];
  for (const frame of frames) {
    const id = addFrame(draft, frame.x + dx, frame.y + dy, frame.w, frame.h, {
      color: frame.color,
      label: frame.label
    });
    frameIds.push(id);
  }
  const wireMap = new Map();
  for (const wire of wires) {
    const id = addWire(
      draft,
      shiftedById.get(wire.id),
      { kind: 'free' },
      { kind: 'free' }
    );
    wireMap.set(wire.id, id);
  }
  for (const wire of wires) {
    const newId = wireMap.get(wire.id);
    const newWire = draft.wires[newId];
    const endA = mapCopyEnd(wire.endA, componentMap, wireMap, dx, dy, detachExternal);
    const endB = mapCopyEnd(wire.endB, componentMap, wireMap, dx, dy, detachExternal);
    if (!endA || !endB) {
      return fail(
        REASONS.COPY_BLOCKED,
        componentPreview.targets,
        shiftedWires.map(function (item) { return item.points; })
      );
    }
    newWire.endA = endA;
    newWire.endB = endB;
  }

  const bounds = componentBoundsList(draft, definitionOptions);
  if (!junctionsValid(draft) || !wireCellsValid(draft, definitionOptions, bounds)) {
    return fail(
      REASONS.COPY_BLOCKED,
      componentPreview.targets,
      shiftedWires.map(function (item) { return item.points; })
    );
  }

  // 复制后的新引脚若正好落在已有/复制导线的 free 端点上，自动接上。
  // 预览与提交共用这份 draft，保证虚线框有效性与最终结果一致。
  const autoAttached = autoAttachFreeEnds(draft, Array.from(componentMap.values()), {
    definitions: definitionOptions.definitions
  });
  // 自动接线可能改变 net，整批校验共享接管后的拓扑和几何索引。
  const validation = wires.length > 0 || autoAttached.size > 0
    ? wireValidation(draft, definitionOptions, bounds)
    : null;

  for (const wire of wires) {
    const newId = wireMap.get(wire.id);
    const newWire = draft.wires[newId];
    if (!checkMovedWire(draft, newId, newWire.points, definitionOptions, validation).ok) {
      return fail(
        REASONS.COPY_BLOCKED,
        componentPreview.targets,
        shiftedWires.map(function (item) { return item.points; })
      );
    }
    const ends = [
      { end: newWire.endA, point: newWire.points[0] },
      { end: newWire.endB, point: newWire.points[newWire.points.length - 1] }
    ];
    for (const item of ends) {
      if (item.end && item.end.kind === 'free') {
        if (!movedEndpointValid(draft, newId, item.end, item.point, definitionOptions, validation)) {
          return fail(
            REASONS.COPY_BLOCKED,
            componentPreview.targets,
            shiftedWires.map(function (entry) { return entry.points; })
          );
        }
      }
    }
  }
  const attachmentFailure = copiedAttachmentsFailure(draft, autoAttached, definitionOptions, validation);
  if (attachmentFailure) {
    return fail(
      attachmentFailure,
      componentPreview.targets,
      shiftedWires.map(function (item) { return item.points; })
    );
  }

  for (const id of componentMap.values()) {
    const component = draft.components[id];
    for (const def of componentPins(component, definitionOptions.definitions) || []) {
      const point = pinWorld(component, def.id, definitionOptions.definitions);
      if (pinHitsForeignWire(draft, id, def.id, point)) {
        return fail(
          REASONS.COPY_BLOCKED,
          componentPreview.targets,
          shiftedWires.map(function (wire) { return wire.points; })
        );
      }
    }
  }

  return {
    ok: true,
    state: draft,
    components: componentPreview.targets,
    wires: shiftedWires.map(function (wire) { return wire.points; }),
    frames: shiftedFrames,
    componentIds: Array.from(componentMap.values()),
    wireIds: Array.from(wireMap.values()),
    frameIds,
    dx: dxCells,
    dy: dyCells
  };
}

export function copySelectionCommand(state, snapshot, anchorCx, anchorCy, definitionOptions = {}) {
  const preview = previewCopySelection(state, snapshot, anchorCx, anchorCy, { definitions: definitionOptions.definitions });
  if (!preview.ok) {
    return reject(preview.reason);
  }
  return {
    ok: true,
    state: preview.state,
    componentIds: preview.componentIds,
    wireIds: preview.wireIds,
    frameIds: preview.frameIds
  };
}

export function toggleComponent(state, id) {
  const draft = clone(state);
  const component = draft.components[id];
  if (!component || component.type !== 'TOGGLE') {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  component.on = !component.on;
  return { ok: true, state: draft, inputOnly: true };
}

export function setButtonPressed(state, id, pressed) {
  const draft = clone(state);
  const component = draft.components[id];
  if (!component || component.type !== 'BUTTON') {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  component.on = Boolean(pressed);
  return { ok: true, state: draft, inputOnly: true };
}

export function setClockPeriodCommand(state, id, period) {
  const normalized = normalizeClockPeriod(period);
  const component = state.components[id];
  if (normalized === null || !component || component.type !== 'CLOCK') {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const draft = clone(state);
  draft.components[id].period = normalized;
  return { ok: true, state: draft };
}

export function resetClocksCommand(state) {
  const reset = resetClockValues(state);
  return { ok: true, state: reset.state };
}


function wirePassesThroughPoint(wire, point) {
  const points = (wire && wire.points) || [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if ((a.x === point.x && a.y === point.y) || (b.x === point.x && b.y === point.y)) {
      return true;
    }
    if (pointOnSegmentInterior(point, a, b)) {
      return true;
    }
  }
  return false;
}

function wirePassesThroughBounds(wire, bounds) {
  for (const point of polylinePoints((wire && wire.points) || [])) {
    if (pointInBounds(point, bounds, false)) {
      return true;
    }
  }
  return false;
}

function pinHitsForeignWire(state, componentId, pinId, point) {
  for (const wire of Object.values(state.wires)) {
    const attachedHere = [wire.endA, wire.endB].some(function (end) {
      return Boolean(end) && end.kind === 'pin' &&
        end.componentId === componentId && end.pinId === pinId;
    });
    if (attachedHere) {
      continue;
    }
    if (wirePassesThroughPoint(wire, point)) {
      return true;
    }
  }
  return false;
}

function componentPinContactsValid(state, ids, definitionOptions) {
  for (const id of ids) {
    const component = state.components[id];
    for (const def of componentPins(component, definitionOptions.definitions) || []) {
      const point = pinWorld(component, def.id, definitionOptions.definitions);
      if (pinHitsForeignWire(state, id, def.id, point)) return false;
    }
  }
  return true;
}

function touchedWiresValid(state, ids, definitionOptions) {
  for (const id of ids) {
    if (!checkMovedWire(state, id, state.wires[id].points, definitionOptions).ok) return false;
  }
  return true;
}

function freeWireEndsAt(state, point) {
  const hits = [];
  for (const wireId of Object.keys(state.wires)) {
    const wire = state.wires[wireId];
    const points = wire && wire.points;
    if (!points || points.length < 2) {
      continue;
    }
    const ends = [
      { end: wire.endA, side: 'A', point: points[0] },
      { end: wire.endB, side: 'B', point: points[points.length - 1] }
    ];
    for (const item of ends) {
      if (item.end && item.end.kind === 'free' && samePoint(item.point, point)) {
        hits.push({ wireId, side: item.side });
      }
    }
  }
  return hits;
}

// 元件移动后，若某个未接线引脚正好落在其它导线的 free 端点上，就把该端接上。
// 一个点上有多个 free 端时保持歧义并交给后续 pinHitsForeignWire 拒绝。
function freeEndpointTargetAt(state, point) {
  if (freeWireEndsAt(state, point).length !== 1) {
    return false;
  }
  let touching = 0;
  for (const wire of Object.values(state.wires)) {
    if (wirePassesThroughPoint(wire, point)) {
      touching += 1;
    }
  }
  return touching === 1;
}

function detachComponentPinEnds(state, componentIds) {
  const ids = new Set(componentIds);
  const detached = new Set();
  for (const wireId of Object.keys(state.wires)) {
    const wire = state.wires[wireId];
    for (const side of ['A', 'B']) {
      const end = side === 'A' ? wire.endA : wire.endB;
      if (end && end.kind === 'pin' && ids.has(end.componentId)) {
        if (side === 'A') {
          wire.endA = { kind: 'free' };
        } else {
          wire.endB = { kind: 'free' };
        }
        detached.add(wireId);
      }
    }
  }
  return detached;
}

function autoAttachFreeEnds(state, componentIds, definitionOptions = {}) {
  const attached = new Set();
  for (const componentId of componentIds) {
    const component = state.components[componentId];
    if (!component) {
      continue;
    }
    for (const def of componentPins(component, definitionOptions.definitions) || []) {
      if (isPinConnected(state, componentId, def.id)) {
        continue;
      }
      const point = pinWorld(component, def.id, definitionOptions.definitions);
      const hits = freeWireEndsAt(state, point);
      if (hits.length !== 1) {
        continue;
      }
      const hit = hits[0];
      const wire = state.wires[hit.wireId];
      if (!wire) {
        continue;
      }
      const pinEnd = { kind: 'pin', componentId, pinId: def.id };
      if (hit.side === 'A') {
        wire.endA = pinEnd;
      } else {
        wire.endB = pinEnd;
      }
      attached.add(hit.wireId);
    }
  }
  return attached;
}

function hasSecondDriver(state, definitionOptions = {}, netIndex) {
  const { nets } = netIndex || buildNets(state, { definitions: definitionOptions.definitions });
  return nets.some(function (net) {
    return net.driverPins.length >= 2;
  });
}

function junctionsValid(state) {
  for (const wire of Object.values(state.wires)) {
    for (const end of [wire.endA, wire.endB]) {
      if (!end || end.kind !== 'junction') {
        continue;
      }
      const host = state.wires[end.wireId];
      if (!host) {
        return false;
      }
      if (!pointOnPolylineInterior(host.points, end.point).on) {
        return false;
      }
    }
  }
  return true;
}

function componentBoundsList(state, definitionOptions) {
  return Object.values(state.components).map(function (component) {
    return componentBounds(component, definitionOptions.definitions);
  });
}

function componentPinKeys(state, definitionOptions) {
  const pins = new Set();
  for (const component of Object.values(state.components)) {
    for (const def of componentPins(component, definitionOptions.definitions) || []) {
      pins.add(pointKeyOf(pinWorld(component, def.id, definitionOptions.definitions)));
    }
  }
  return pins;
}

function polylineBounds(points) {
  if (points.length === 0) return null;
  let minX = points[0].x;
  let maxX = minX;
  let minY = points[0].y;
  let maxY = minY;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function wireEntersBounds(expanded, envelope, boundsList) {
  for (const bounds of boundsList) {
    if (!boundsOverlap(envelope, bounds)) continue;
    for (const point of expanded) {
      if (pointInBounds(point, bounds, false)) return true;
    }
  }
  return false;
}

function wireCellsValid(state, definitionOptions = {}, boundsList = componentBoundsList(state, definitionOptions)) {
  for (const wire of Object.values(state.wires)) {
    const points = wire?.points || [];
    if (wireEntersBounds(polylinePoints(points), polylineBounds(points), boundsList)) return false;
  }
  return true;
}

function endPointOf(state, end, wire, side, definitionOptions = {}) {
  if (!end) {
    return null;
  }
  if (end.kind === 'pin') {
    const component = state.components[end.componentId];
    if (!component) {
      return null;
    }
    try {
      return pinWorld(component, end.pinId, definitionOptions.definitions);
    } catch (err) {
      return null;
    }
  }
  if (end.kind === 'junction') {
    return { x: end.point.x, y: end.point.y };
  }
  if (end.kind === 'free') {
    const points = (wire && wire.points) || [];
    if (points.length === 0) {
      return null;
    }
    const point = side === 'A' ? points[0] : points[points.length - 1];
    return { x: point.x, y: point.y };
  }
  return null;
}

// 引脚所在元件边的外法线；引脚在角点或不在边上时返回 null。
function pinEdgeNormal(component, pinId, definitionOptions = {}) {
  const pin = pinWorld(component, pinId, definitionOptions.definitions);
  const bounds = componentBounds(component, definitionOptions.definitions);
  const x0 = bounds.x;
  const x1 = bounds.x + bounds.w;
  const y0 = bounds.y;
  const y1 = bounds.y + bounds.h;
  if (pin.x === x0) {
    return { x: -1, y: 0 };
  }
  if (pin.x === x1) {
    return { x: 1, y: 0 };
  }
  if (pin.y === y0) {
    return { x: 0, y: -1 };
  }
  if (pin.y === y1) {
    return { x: 0, y: 1 };
  }
  return null;
}

// 若固定引脚后的第一/末段贴着元件边，先沿法线离开一个网格步再转折。
function escapePinEdge(component, pinId, points, atStart, definitionOptions = {}) {
  if (!component || !Array.isArray(points) || points.length < 2) {
    return points;
  }
  const pin = pinWorld(component, pinId, definitionOptions.definitions);
  const adjacentIndex = atStart ? 1 : points.length - 2;
  if (!segmentOverlapsComponentEdge(pin, points[adjacentIndex], component, { definitions: definitionOptions.definitions })) {
    return points;
  }
  const normal = pinEdgeNormal(component, pinId, { definitions: definitionOptions.definitions });
  if (!normal) {
    return points;
  }
  const step = { x: normal.x * WIRE_GRID, y: normal.y * WIRE_GRID };
  const outward = { x: pin.x + step.x, y: pin.y + step.y };
  const shiftedAdjacent = {
    x: points[adjacentIndex].x + step.x,
    y: points[adjacentIndex].y + step.y
  };
  if (atStart) {
    return simplify([pin, outward, shiftedAdjacent].concat(points.slice(2).map(function (point) {
      return { x: point.x, y: point.y };
    })));
  }
  return simplify(points.slice(0, points.length - 2).map(function (point) {
    return { x: point.x, y: point.y };
  }).concat([shiftedAdjacent, outward, pin]));
}

// 移动元件时保留原导线的候选折线：先试投影（少拐点），再试保留旧端点的 L 连接。
// 目的：不要因为端点移动就把整根线重布，从而丢掉线上的 T 点。
function stretchWireCandidates(points, atStart, newPoint) {
  if (!Array.isArray(points) || points.length < 2) {
    return [];
  }
  const oldPoint = atStart ? points[0] : points[points.length - 1];
  const adjacent = atStart ? points[1] : points[points.length - 2];
  if (samePoint(oldPoint, newPoint)) {
    return [points.map(function (point) {
      return { x: point.x, y: point.y };
    })];
  }
  const horizontal = oldPoint.y === adjacent.y;
  const clone = function (point) {
    return { x: point.x, y: point.y };
  };
  const head = points.slice(0, atStart ? 0 : points.length - 1).map(clone);
  const tail = points.slice(atStart ? 1 : points.length).map(clone);
  const out = [];
  const seen = new Set();

  function push(candidate) {
    const simple = simplify(candidate);
    const key = simple.map(function (point) {
      return point.x + ',' + point.y;
    }).join(';');
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push(simple);
  }

  // 1) 把旧首/末段沿原轴延长或缩短，端点投影到旧线上。
  const projection = horizontal
    ? { x: newPoint.x, y: oldPoint.y }
    : { x: oldPoint.x, y: newPoint.y };
  push(atStart
    ? [clone(newPoint), projection].concat(tail)
    : head.concat([projection, clone(newPoint)]));

  // 2) 保留旧端点，用 L 形连接器接到新端点。
  const corner = horizontal
    ? { x: oldPoint.x, y: newPoint.y }
    : { x: newPoint.x, y: oldPoint.y };
  push(atStart
    ? [clone(newPoint), corner, clone(oldPoint)].concat(tail)
    : head.concat([clone(oldPoint), corner, clone(newPoint)]));

  return out;
}

export function moveComponent(state, id, cx, cy, definitionOptions = {}) {
  const draft = clone(state);
  const component = draft.components[id];
  if (!component) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  const check = checkComponentPlacement(
    draft,
    component,
    cx,
    cy,
    component.rotation || 0,
    id
  , { definitions: definitionOptions.definitions });
  if (!check.ok) {
    return reject(check.reason);
  }

  // 记录受影响的导线：一端接在该元件引脚上，另一端保持原位。
  // 两端都接在同一元件引脚上的“自环导线”不参与拉伸，随元件世界位移整体平移。
  const oldCx = component.cx;
  const oldCy = component.cy;
  const affected = [];
  const selfLoops = [];
  for (const wireId of Object.keys(draft.wires).sort()) {
    const wire = draft.wires[wireId];
    const aIsPin = Boolean(wire.endA) && wire.endA.kind === 'pin' && wire.endA.componentId === id;
    const bIsPin = Boolean(wire.endB) && wire.endB.kind === 'pin' && wire.endB.componentId === id;
    if (aIsPin && bIsPin) {
      selfLoops.push({ wireId });
      continue;
    }
    if (!aIsPin && !bIsPin) {
      continue;
    }
    const pinEnd = aIsPin ? wire.endA : wire.endB;
    const otherEnd = aIsPin ? wire.endB : wire.endA;
    const otherPoint = endPointOf(draft, otherEnd, wire, aIsPin ? 'B' : 'A', { definitions: definitionOptions.definitions });
    if (!otherPoint) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    affected.push({ wireId, pinEnd, otherEnd, otherPoint, pinIsA: aIsPin });
  }

  component.cx = cx;
  component.cy = cy;

  // 自环导线：保留 endA/endB 的 pin 身份，所有折点按元件世界位移整体平移。
  const moveDx = (cx - oldCx) * CELL;
  const moveDy = (cy - oldCy) * CELL;
  for (const item of selfLoops) {
    const wire = draft.wires[item.wireId];
    wire.points = translateWirePoints(wire.points, moveDx, moveDy);
  }

  // 受影响的线优先“保持拐点只拉伸”；拉伸都不合法时，无 T 锚点才重新布线。
  for (const item of affected) {
    const start = pinWorld(component, item.pinEnd.pinId, definitionOptions.definitions);
    const oldPoints = draft.wires[item.wireId].points;
    const candidates = stretchWireCandidates(oldPoints, item.pinIsA, start).map(function (candidate) {
      return escapePinEdge(component, item.pinEnd.pinId, candidate, item.pinIsA, { definitions: definitionOptions.definitions });
    });
    let chosen = null;
    for (const candidate of candidates) {
      if (checkMovedWire(draft, item.wireId, candidate, { definitions: definitionOptions.definitions }).ok) {
        chosen = candidate;
        break;
      }
    }

    if (!chosen) {
      // 有 T 锚点时，整根重布会拆掉锚点；直接拒绝，不静默拆线。
      if (wireHasIncomingJunction(draft, item.wireId)) {
        return reject(REASONS.ILLEGAL_GEOMETRY);
      }
      const ignoreNetOf = collectNetWireIds(draft, [item.pinEnd, item.otherEnd], { definitions: definitionOptions.definitions });
      // 被重布线的线本身不能作为障碍，否则旧走线会把自己逼出绕行。
      const routingState = {
        nextId: draft.nextId,
        components: draft.components,
        wires: Object.assign({}, draft.wires)
      };
      delete routingState.wires[item.wireId];
      const routed = route(routingState, start, item.otherPoint, Object.assign({}, {
        allowTouching: [start, item.otherPoint],
        ignoreNetOf
      }, { definitions: definitionOptions.definitions }));
      if (!routed.ok) {
        return reject(routed.reason);
      }
      if (item.otherEnd.kind === 'junction') {
        const host = draft.wires[item.otherEnd.wireId];
        if (!host) {
          return reject(REASONS.ILLEGAL_GEOMETRY);
        }
        const hit = pointOnPolylineInterior(host.points, item.otherEnd.point);
        if (!hit.on) {
          return reject(REASONS.ILLEGAL_GEOMETRY);
        }
        if (!isPerpendicularToHost(routed.points, false, { points: host.points, index: hit.index })) {
          return reject(REASONS.ILLEGAL_GEOMETRY);
        }
      }
      // route 从被移动的引脚出发；折线顺序必须保持 endA→endB，否则 free 端点会错位。
      chosen = item.pinIsA ? routed.points : routed.points.slice().reverse();
    }

    draft.wires[item.wireId].points = JSON.parse(JSON.stringify(chosen));
  }

  // 受影响导线已更新到新引脚位置后，再判断新引脚是否压在其它导线上。
  // 顺序很重要：向右移动 NOT 时，旧线起点会短暂落在新输入引脚位置，
  // 若提前检查会误判为“引脚压线”。
  const autoAttached = autoAttachFreeEnds(draft, [id], { definitions: definitionOptions.definitions });
  if (!componentPinContactsValid(draft, [id], definitionOptions)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  // 最终校验：junction 仍锚定、导线不穿格、重布线后不与其它线产生非法接触。
  if (!junctionsValid(draft) || !wireCellsValid(draft, { definitions: definitionOptions.definitions })) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const touched = affected.concat(selfLoops).map((item) => item.wireId).concat(Array.from(autoAttached));
  if (!touchedWiresValid(draft, touched, definitionOptions)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (autoAttached.size > 0 && hasSecondDriver(draft, { definitions: definitionOptions.definitions })) {
    return reject(REASONS.SECOND_DRIVER);
  }

  return autoAttached.size > 0
    ? { ok: true, state: draft }
    : { ok: true, state: draft, geometryOnly: true };
}

function translateWirePoints(points, dx, dy) {
  return (points || []).map(function (point) {
    return { x: point.x + dx, y: point.y + dy };
  });
}

// 组移动的元件放置校验：只和未移动的元件比较；移动元件之间相对位置不变。
function groupPlacementCheck(state, movedIds, dxCells, dyCells, definitionOptions = {}) {
  const unmovedIds = Object.keys(state.components).filter(function (id) {
    return !movedIds.has(id);
  });
  const movedPins = [];
  for (const id of movedIds) {
    const component = state.components[id];
    const cx = component.cx + dxCells;
    const cy = component.cy + dyCells;
    const probe = {
      type: component.type,
      definitionId: component.definitionId,
      cx,
      cy,
      rotation: component.rotation || 0
    };
    const targetBounds = componentBounds(probe, definitionOptions.definitions);
    for (const otherId of unmovedIds) {
      const other = state.components[otherId];
      if (boundsOverlap(componentBounds(other, definitionOptions.definitions), targetBounds)) {
        return reject(REASONS.ILLEGAL_GEOMETRY);
      }
    }
    for (const def of componentPins(probe, definitionOptions.definitions) || []) {
      movedPins.push(pinWorld(probe, def.id, definitionOptions.definitions));
    }
  }
  for (const otherId of unmovedIds) {
    const other = state.components[otherId];
    for (const def of componentPins(other, definitionOptions.definitions) || []) {
      const world = pinWorld(other, def.id, definitionOptions.definitions);
      for (const point of movedPins) {
        if (world.x === point.x && world.y === point.y) {
          return reject(REASONS.PIN_COINCIDENT);
        }
      }
    }
  }
  return { ok: true };
}

// 多选整体拖动：元件按整格移动，选中导线/分组框一起平移；未选中的受影响导线拉伸/重布。
export function moveSelectionCommand(state, componentIds, wireIds, dx, dy, frameIds, definitionOptions = {}) {
  const componentList = Array.isArray(componentIds) ? componentIds : [];
  const wireList = Array.isArray(wireIds) ? wireIds : [];
  const frameList = Array.isArray(frameIds) ? frameIds : [];
  if (!Number.isInteger(dx) || !Number.isInteger(dy)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const draft = clone(state);
  const movedComponents = new Set();
  for (const id of componentList) {
    if (draft.components[id]) {
      movedComponents.add(id);
    }
  }
  const movedWires = new Set();
  for (const id of wireList) {
    if (draft.wires[id]) {
      movedWires.add(id);
    }
  }
  const movedFrames = new Set();
  for (const id of frameList) {
    if (draft.frames[id]) {
      movedFrames.add(id);
    }
  }
  if (movedComponents.size === 0 && movedWires.size === 0 && movedFrames.size === 0) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (dx === 0 && dy === 0) {
    return { ok: true, state: draft, geometryOnly: true };
  }
  if ((movedComponents.size > 0 || movedFrames.size > 0) &&
      (dx % CELL !== 0 || dy % CELL !== 0)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (movedComponents.size === 0 && movedFrames.size === 0 &&
      (dx % WIRE_GRID !== 0 || dy % WIRE_GRID !== 0)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const dxCells = dx / CELL;
  const dyCells = dy / CELL;

  // 选中导线整体平移：pin 端必须在被移动元件上；
  // T 网络必须整组选中：junction 的宿主线和所有支线都要在选中集合里。
  for (const wireId of movedWires) {
    const wire = draft.wires[wireId];
    for (const end of [wire.endA, wire.endB]) {
      if (!end) {
        continue;
      }
      if (end.kind === 'pin' && !movedComponents.has(end.componentId)) {
        return reject(REASONS.ILLEGAL_GEOMETRY);
      }
      if (end.kind === 'junction' && !movedWires.has(end.wireId)) {
        return reject(REASONS.ILLEGAL_GEOMETRY);
      }
    }
    for (const otherId of Object.keys(draft.wires)) {
      if (otherId === wireId) {
        continue;
      }
      const other = draft.wires[otherId];
      for (const end of [other.endA, other.endB]) {
        if (
          end &&
          end.kind === 'junction' &&
          end.wireId === wireId &&
          !movedWires.has(otherId)
        ) {
          return reject(REASONS.ILLEGAL_GEOMETRY);
        }
      }
    }
  }

  const placement = groupPlacementCheck(draft, movedComponents, dxCells, dyCells, { definitions: definitionOptions.definitions });
  if (!placement.ok) {
    return placement;
  }

  for (const id of movedComponents) {
    const component = draft.components[id];
    component.cx += dxCells;
    component.cy += dyCells;
  }

  for (const wireId of movedWires) {
    const wire = draft.wires[wireId];
    wire.points = translateWirePoints(wire.points, dx, dy);
    if (wire.endA && wire.endA.kind === 'junction') {
      wire.endA.point = { x: wire.endA.point.x + dx, y: wire.endA.point.y + dy };
    }
    if (wire.endB && wire.endB.kind === 'junction') {
      wire.endB.point = { x: wire.endB.point.x + dx, y: wire.endB.point.y + dy };
    }
  }

  for (const id of movedFrames) {
    const frame = draft.frames[id];
    frame.x += dx;
    frame.y += dy;
  }

  // 未选中的导线：两端都接被移动元件就整体平移；只接一端就拉伸/重布。
  const affected = new Set();
  for (const wireId of Object.keys(draft.wires)) {
    if (movedWires.has(wireId)) {
      continue;
    }
    const wire = draft.wires[wireId];
    const aMoved = Boolean(wire.endA) && wire.endA.kind === 'pin' &&
      movedComponents.has(wire.endA.componentId);
    const bMoved = Boolean(wire.endB) && wire.endB.kind === 'pin' &&
      movedComponents.has(wire.endB.componentId);
    if (!aMoved && !bMoved) {
      continue;
    }
    affected.add(wireId);
    if (aMoved && bMoved) {
      wire.points = translateWirePoints(wire.points, dx, dy);
      continue;
    }

    const pinIsA = aMoved;
    const pinEnd = pinIsA ? wire.endA : wire.endB;
    const component = draft.components[pinEnd.componentId];
    const start = pinWorld(component, pinEnd.pinId, definitionOptions.definitions);
    const candidates = stretchWireCandidates(wire.points, pinIsA, start).map(function (candidate) {
      return escapePinEdge(component, pinEnd.pinId, candidate, pinIsA, { definitions: definitionOptions.definitions });
    });
    let chosen = null;
    for (const candidate of candidates) {
      if (checkMovedWire(draft, wireId, candidate, { definitions: definitionOptions.definitions }).ok) {
        chosen = candidate;
        break;
      }
    }
    if (!chosen) {
      if (wireHasIncomingJunction(draft, wireId)) {
        return reject(REASONS.ILLEGAL_GEOMETRY);
      }
      const otherEnd = pinIsA ? wire.endB : wire.endA;
      const otherPoint = endPointOf(draft, otherEnd, wire, pinIsA ? 'B' : 'A', { definitions: definitionOptions.definitions });
      if (!otherPoint || !isWireGridPoint(otherPoint)) {
        return reject(REASONS.ILLEGAL_GEOMETRY);
      }
      const ignoreNetOf = collectNetWireIds(draft, [pinEnd, otherEnd], { definitions: definitionOptions.definitions });
      const routingState = {
        nextId: draft.nextId,
        components: draft.components,
        wires: Object.assign({}, draft.wires)
      };
      delete routingState.wires[wireId];
      const routed = route(routingState, start, otherPoint, Object.assign({}, {
        allowTouching: [start, otherPoint],
        ignoreNetOf
      }, { definitions: definitionOptions.definitions }));
      if (!routed.ok) {
        return reject(routed.reason);
      }
      if (otherEnd.kind === 'junction') {
        const host = draft.wires[otherEnd.wireId];
        if (!host) {
          return reject(REASONS.ILLEGAL_GEOMETRY);
        }
        const hit = pointOnPolylineInterior(host.points, otherEnd.point);
        if (!hit.on) {
          return reject(REASONS.ILLEGAL_GEOMETRY);
        }
        if (!isPerpendicularToHost(routed.points, false, { points: host.points, index: hit.index })) {
          return reject(REASONS.ILLEGAL_GEOMETRY);
        }
      }
      chosen = pinIsA ? routed.points : routed.points.slice().reverse();
    }
    wire.points = JSON.parse(JSON.stringify(chosen));
  }

  // 移动后的引脚若正好落在未选中导线的 free 端点上，自动接上。
  const autoAttached = autoAttachFreeEnds(draft, movedComponents, { definitions: definitionOptions.definitions });

  // 移动后的引脚不得压到其它导线。
  if (!componentPinContactsValid(draft, movedComponents, definitionOptions)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  if (!junctionsValid(draft) || !wireCellsValid(draft, { definitions: definitionOptions.definitions })) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  const toCheck = new Set();
  for (const id of movedWires) {
    toCheck.add(id);
  }
  for (const id of affected) {
    toCheck.add(id);
  }
  for (const id of autoAttached) {
    toCheck.add(id);
  }
  for (const wireId of toCheck) {
    const wire = draft.wires[wireId];
    const checkWire = checkMovedWire(draft, wireId, wire.points, { definitions: definitionOptions.definitions });
    if (!checkWire.ok) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    if (movedWires.has(wireId)) {
      const ends = [
        { end: wire.endA, point: wire.points[0] },
        { end: wire.endB, point: wire.points[wire.points.length - 1] }
      ];
      for (const item of ends) {
        if (item.end && item.end.kind === 'free') {
          if (!movedEndpointValid(draft, wireId, item.end, item.point, { definitions: definitionOptions.definitions })) {
            return reject(REASONS.ILLEGAL_GEOMETRY);
          }
        }
      }
    }
  }

  if (autoAttached.size > 0 && hasSecondDriver(draft, { definitions: definitionOptions.definitions })) {
    return reject(REASONS.SECOND_DRIVER);
  }

  return autoAttached.size > 0
    ? { ok: true, state: draft }
    : { ok: true, state: draft, geometryOnly: true };
}

// 对选中的导线重新自动布线：保持两端锚点（pin / junction / free）与拓扑不变，只重排折线几何。
// 有其它导线以 junction 锚在本线内部时拒绝，避免整根重布静默拆掉 T 分支。
// 多选时逐根按 id 排序重布；任一失败整体拒绝，已重布的候选不落盘。
export function autoRouteWires(state, wireIds, definitionOptions = {}) {
  const ids = Array.isArray(wireIds) ? wireIds.slice() : [];
  const seen = new Set();
  const ordered = ids.filter(function (id) {
    if (typeof id !== 'string' || seen.has(id)) {
      return false;
    }
    seen.add(id);
    return true;
  }).sort();
  if (ordered.length === 0) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  const draft = clone(state);
  const routedIds = [];
  for (const wireId of ordered) {
    const wire = draft.wires[wireId];
    if (!wire || !Array.isArray(wire.points) || wire.points.length < 2) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    if (wireHasIncomingJunction(draft, wireId)) {
      return reject(REASONS.WIRED_OBJECT_LOCKED);
    }

    const start = endPointOf(draft, wire.endA, wire, 'A', { definitions: definitionOptions.definitions });
    const goal = endPointOf(draft, wire.endB, wire, 'B', { definitions: definitionOptions.definitions });
    if (!start || !goal || (start.x === goal.x && start.y === goal.y)) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }

    // 被重布的线本身不能作为障碍；同 net 其它线保留精确接触限制，只放宽 1 格间距。
    const routingState = {
      nextId: draft.nextId,
      components: draft.components,
      wires: Object.assign({}, draft.wires)
    };
    delete routingState.wires[wireId];
    const ignoreNetOf = collectNetWireIds(draft, [wire.endA, wire.endB], {
      definitions: definitionOptions.definitions
    });
    const routeOptions = Object.assign({}, {
      allowTouching: [start, goal],
      ignoreNetOf
    }, { definitions: definitionOptions.definitions });

    let chosen = null;
    let reason = REASONS.NO_ROUTE;
    const forward = route(routingState, start, goal, routeOptions);
    if (forward.ok) {
      const check = checkMovedWire(draft, wireId, forward.points, {
        definitions: definitionOptions.definitions
      });
      if (check.ok) {
        chosen = forward.points;
      } else {
        reason = check.reason;
      }
    } else {
      reason = forward.reason;
    }

    // 反向再试一次：改变 Dijkstra 的 tie-break，提高 junction 端点垂直落线的成功率。
    if (!chosen) {
      const backward = route(routingState, goal, start, routeOptions);
      if (backward.ok) {
        const candidate = backward.points.slice().reverse();
        const check = checkMovedWire(draft, wireId, candidate, {
          definitions: definitionOptions.definitions
        });
        if (check.ok) {
          chosen = candidate;
        } else {
          reason = check.reason;
        }
      } else if (reason === REASONS.NO_ROUTE) {
        reason = backward.reason;
      }
    }

    if (!chosen) {
      return reject(reason);
    }
    draft.wires[wireId].points = JSON.parse(JSON.stringify(chosen));
    routedIds.push(wireId);
  }

  // 多选逐根重布后，后面的线可能改变与前面线的接触关系；对全部已重布线再验一次。
  for (const wireId of routedIds) {
    const check = checkMovedWire(draft, wireId, draft.wires[wireId].points, {
      definitions: definitionOptions.definitions
    });
    if (!check.ok) {
      return reject(check.reason);
    }
  }

  return { ok: true, state: draft, wireIds: routedIds, geometryOnly: true };
}

// 两个旋转入口保留各自的放置校验，后续接线顺序完全一致。
function finishComponentRotation(draft, ids, definitionOptions) {
  const detached = detachComponentPinEnds(draft, ids);
  const autoAttached = autoAttachFreeEnds(draft, ids, { definitions: definitionOptions.definitions });
  if (!componentPinContactsValid(draft, ids, definitionOptions)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  if (!junctionsValid(draft) || !wireCellsValid(draft, { definitions: definitionOptions.definitions })) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const touched = new Set(Array.from(detached).concat(Array.from(autoAttached)));
  if (!touchedWiresValid(draft, touched, definitionOptions)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (autoAttached.size > 0 && hasSecondDriver(draft, { definitions: definitionOptions.definitions })) {
    return reject(REASONS.SECOND_DRIVER);
  }

  return touched.size > 0
    ? { ok: true, state: draft }
    : { ok: true, state: draft, geometryOnly: true };
}

export function rotateComponent(state, id, deltaSteps, definitionOptions = {}) {
  const draft = clone(state);
  const component = draft.components[id];
  if (!component) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const rotation = normalizeRotation((component.rotation || 0) + (deltaSteps || 0));
  const check = checkComponentPlacement(
    draft,
    component,
    component.cx,
    component.cy,
    rotation,
    id
  , { definitions: definitionOptions.definitions });
  if (!check.ok) {
    return reject(check.reason);
  }
  component.rotation = rotation;

  // 旋转会改变引脚位置：先解除本元件引脚上的导线端点，再按新位置自动接管
  // 仍与引脚重合的 free 端点。旋转 180° 时同一位置的线会接到对面的引脚。
  return finishComponentRotation(draft, [id], definitionOptions);
}

// 多选整体旋转：所有选中元件一起转；已接线端点先脱开，再按新引脚位置自动接管。
export function rotateSelectionCommand(state, componentIds, deltaSteps, definitionOptions = {}) {
  const ids = Array.isArray(componentIds) ? componentIds : [];
  if (ids.length === 0) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const draft = clone(state);
  const steps = normalizeRotation(deltaSteps || 0);
  for (const id of ids) {
    const component = draft.components[id];
    if (!component) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
  }
  for (const id of ids) {
    const component = draft.components[id];
    component.rotation = normalizeRotation((component.rotation || 0) + steps);
  }
  for (const id of ids) {
    const component = draft.components[id];
    const check = checkComponentPlacement(
      draft,
      component,
      component.cx,
      component.cy,
      component.rotation,
      id
    , { definitions: definitionOptions.definitions });
    if (!check.ok) {
      return reject(check.reason);
    }
  }

  return finishComponentRotation(draft, ids, definitionOptions);
}

export function deleteWire(state, wireId) {
  const draft = clone(state);
  if (!draft.wires[wireId]) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  delete draft.wires[wireId];
  const wireIds = Object.keys(draft.wires);
  for (const id of wireIds) {
    const wire = draft.wires[id];
    wire.endA = detachJunction(wire.endA, wireId);
    wire.endB = detachJunction(wire.endB, wireId);
  }
  return { ok: true, state: draft };
}

function detachJunction(end, wireId) {
  if (end && end.kind === 'junction' && end.wireId === wireId) {
    return { kind: 'free' };
  }
  return end;
}

function endPoint(state, end, definitionOptions = {}) {
  if (!end) {
    return null;
  }
  if (end.kind === 'pin') {
    const component = state.components[end.componentId];
    if (!component) {
      return null;
    }
    try {
      const world = pinWorld(component, end.pinId, definitionOptions.definitions);
      return { x: world.x, y: world.y };
    } catch (err) {
      return null;
    }
  }
  if (end.kind === 'junction') {
    if (!end.point) {
      return null;
    }
    return { x: end.point.x, y: end.point.y };
  }
  return null;
}

function junctionHost(state, end) {
  if (!end || end.kind !== 'junction') {
    return { ok: true, host: null };
  }
  const wire = state.wires[end.wireId];
  if (!wire || !end.point) {
    return { ok: false };
  }
  const hit = pointOnPolylineInterior(wire.points, end.point);
  if (!hit.on || typeof hit.index !== 'number') {
    return { ok: false };
  }
  return {
    ok: true,
    host: { wireId: end.wireId, index: hit.index, points: wire.points }
  };
}

function collectNetWireIds(state, ends, definitionOptions = {}) {
  const built = buildNets(state, { definitions: definitionOptions.definitions });
  const seen = new Set();
  for (const end of ends) {
    if (!end) {
      continue;
    }
    let netId;
    if (end.kind === 'pin') {
      netId = built.netIdOfPin[end.componentId + ':' + end.pinId];
    } else if (end.kind === 'junction') {
      netId = built.netIdOfWire[end.wireId];
    }
    if (netId === undefined) {
      continue;
    }
    const net = built.nets.find(function (candidate) {
      return candidate.id === netId;
    });
    if (!net) {
      continue;
    }
    for (const wireId of net.wireIds) {
      seen.add(wireId);
    }
  }
  return Array.from(seen);
}

function junctionAdjacentDirection(points, atStart) {
  if (!points || points.length < 2) {
    return null;
  }
  if (atStart) {
    return segmentDirection(points[0], points[1]);
  }
  return segmentDirection(points[points.length - 2], points[points.length - 1]);
}

function isPerpendicularToHost(points, atStart, host) {
  const adjacent = junctionAdjacentDirection(points, atStart);
  if (!adjacent) {
    return false;
  }
  const hostDirection = segmentDirection(host.points[host.index], host.points[host.index + 1]);
  return adjacent.x * hostDirection.x + adjacent.y * hostDirection.y === 0;
}

export function previewConnect(state, endA, endB, definitionOptions = {}) {
  const check = checkConnect(state, endA, endB, { definitions: definitionOptions.definitions });
  if (!check.ok) {
    return reject(check.reason);
  }

  const startPoint = endPoint(state, endA, { definitions: definitionOptions.definitions });
  const goalPoint = endPoint(state, endB, { definitions: definitionOptions.definitions });
  if (!startPoint || !goalPoint) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (!isWireGridPoint(startPoint) || !isWireGridPoint(goalPoint)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  const hostA = junctionHost(state, endA);
  if (!hostA.ok) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const hostB = junctionHost(state, endB);
  if (!hostB.ok) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  // 端点不得落在别人的导线上：几何重合不等于导通，落上去只会产生歧义。
  for (const item of [
    { end: endA, point: startPoint, host: hostA.host },
    { end: endB, point: goalPoint, host: hostB.host }
  ]) {
    const allowedWireId = item.end.kind === 'junction' && item.host ? item.end.wireId : null;
    if (touchesForeignWire(state, item.point, allowedWireId)) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
  }

  const allowTouching = [startPoint, goalPoint];
  const ignoreNetOf = collectNetWireIds(state, [endA, endB], { definitions: definitionOptions.definitions });
  const routed = route(state, startPoint, goalPoint, Object.assign({}, { allowTouching, ignoreNetOf }, { definitions: definitionOptions.definitions }));
  if (!routed.ok) {
    return reject(routed.reason);
  }
  if (polylineOverlapsComponentEdge(routed.points, Object.values(state.components), { definitions: definitionOptions.definitions })) {
    return reject(REASONS.WIRE_ON_COMPONENT_EDGE);
  }

  if (hostA.host && !isPerpendicularToHost(routed.points, true, hostA.host)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (hostB.host && !isPerpendicularToHost(routed.points, false, hostB.host)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  return { ok: true, points: routed.points };
}


function touchesForeignWire(state, point, allowedWireId) {
  for (const wireId of Object.keys(state.wires)) {
    if (wireId === allowedWireId) {
      continue;
    }
    const wire = state.wires[wireId];
    const points = wire.points || [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      if ((a.x === point.x && a.y === point.y) || (b.x === point.x && b.y === point.y)) {
        return true;
      }
      if (pointOnSegmentInterior(point, a, b)) {
        return true;
      }
    }
  }
  return false;
}

export function connect(state, endA, endB, definitionOptions = {}) {
  const preview = previewConnect(state, endA, endB, { definitions: definitionOptions.definitions });
  if (!preview.ok) {
    return reject(preview.reason);
  }

  const draft = clone(state);
  const points = JSON.parse(JSON.stringify(preview.points));
  const id = addWire(draft, points, clone(endA), clone(endB));
  return { ok: true, state: draft, id, points };
}

// ── 线段拖动 ────────────────────────────────────────────────────────────────
// 契约：端点不动；只把被拖的那一段沿垂直方向按 4 单位平移；相邻段可缩短到 0
// 并在简化中合并（可把凹陷段拖成直线），也可反向形成新的折线；两侧都有拐角时
// 只移动该段端点，触及导线端点时补 1 个拐点，整根线只有一段时两端各补 1 个。
// 最终按布线不变量重新校验。

function pointKeyOf(point) {
  return point.x + ',' + point.y;
}

function samePoint(a, b) {
  return a.x === b.x && a.y === b.y;
}

function simpleOrthogonalPoints(points) {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }
  for (const point of points) {
    if (!isWireGridPoint(point)) {
      return null;
    }
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const horizontal = a.y === b.y && a.x !== b.x;
    const vertical = a.x === b.x && a.y !== b.y;
    if (!horizontal && !vertical) {
      return null;
    }
  }
  // 有共线中间点或重复点说明折线没有规范化；自身交叉/重叠会让同一单位点出现两次。
  if (simplify(points).length !== points.length) {
    return null;
  }
  const seen = new Set();
  const expanded = polylinePoints(points);
  for (const point of expanded) {
    const key = pointKeyOf(point);
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
  }
  return expanded;
}

function endpointPoint(points, atStart) {
  return atStart ? points[0] : points[points.length - 1];
}

// 端点规则：
// - pin 端点必须仍在引脚世界坐标上（不能移动）；
// - junction 端点必须仍在宿主线段内部，且支线与宿主垂直；
// - free 端点没有额外锚定。
// 同时检查其它线锚在本线内部的 T 点仍落在新折线内部且垂直。
function endpointsPreserved(state, wireId, points, definitionOptions = {}) {
  const wire = state.wires[wireId];
  for (const otherId of Object.keys(state.wires)) {
    if (otherId === wireId) {
      continue;
    }
    const other = state.wires[otherId];
    const ends = [
      { end: other.endA, atStart: true },
      { end: other.endB, atStart: false }
    ];
    for (const item of ends) {
      const end = item.end;
      if (!end || end.kind !== 'junction' || end.wireId !== wireId) {
        continue;
      }
      const hit = pointOnPolylineInterior(points, end.point);
      if (!hit.on) {
        return false;
      }
      if (!isPerpendicularToHost(other.points, item.atStart, { points, index: hit.index })) {
        return false;
      }
    }
  }

  const ends = [
    { end: wire.endA, atStart: true },
    { end: wire.endB, atStart: false }
  ];
  for (const item of ends) {
    const end = item.end;
    if (!end) {
      continue;
    }
    const point = endpointPoint(points, item.atStart);
    if (end.kind === 'pin') {
      const component = state.components[end.componentId];
      if (!component) {
        return false;
      }
      let world;
      try {
        world = pinWorld(component, end.pinId, definitionOptions.definitions);
      } catch (err) {
        return false;
      }
      if (!samePoint(point, world)) {
        return false;
      }
    } else if (end.kind === 'junction') {
      const host = state.wires[end.wireId];
      if (!host) {
        return false;
      }
      const hit = pointOnPolylineInterior(host.points, point);
      if (!hit.on) {
        return false;
      }
      if (!isPerpendicularToHost(points, item.atStart, { points: host.points, index: hit.index })) {
        return false;
      }
    }
  }
  return true;
}

function wireContactIndex(state, definitionOptions, ignoredWireId) {
  let wires = state.wires;
  if (ignoredWireId !== undefined) {
    wires = { ...wires };
    delete wires[ignoredWireId];
  }
  return {
    built: buildNets(state, { definitions: definitionOptions.definitions }),
    meta: buildWireMeta({ wires }, { includeGates: false }).meta
  };
}

function wireValidation(state, definitionOptions, bounds = componentBoundsList(state, definitionOptions)) {
  return {
    ...wireContactIndex(state, definitionOptions),
    bounds,
    pins: componentPinKeys(state, definitionOptions)
  };
}

function foreignWireTooClose(meta, netIds, netId, point, allowedWireId) {
  for (let dx = -1; dx <= 1; dx += 1) {
    for (let dy = -1; dy <= 1; dy += 1) {
      const entries = meta.get((point.x + dx) + ',' + (point.y + dy));
      if (!entries) continue;
      for (const entry of entries) {
        if (entry.wireId !== allowedWireId && netIds[entry.wireId] !== netId) return true;
      }
    }
  }
  return false;
}

// 移动后的 free / junction 端点不能压在别的导线或引脚上；junction 豁免自己的宿主。
function movedEndpointValid(state, wireId, end, point, definitionOptions = {}, validation) {
  const { built, meta } = validation || wireContactIndex(state, definitionOptions, wireId);
  const allowedWireId = end.kind === 'junction' ? end.wireId : null;
  const key = pointKeyOf(point);
  const entries = meta.get(key);
  if (entries?.some(entry => entry.wireId !== wireId && entry.wireId !== allowedWireId)) {
    return false;
  }
  const netIds = built.netIdOfWire;
  if (foreignWireTooClose(meta, netIds, netIds[wireId], point, allowedWireId)) return false;
  const pins = validation?.pins || componentPinKeys(state, definitionOptions);
  return !pins.has(key);
}

function isDeclaredBranchContact(branch, hostId, point) {
  return [branch.endA, branch.endB].some(function (end, index) {
    return end?.kind === 'junction' && end.wireId === hostId &&
      samePoint(end.point, point) && samePoint(endpointPoint(branch.points, index === 0), point);
  });
}

// 与其它导线的接触规则与 router.validateCrossings / clearance 保持一致：
// 只允许“双方内部直穿 + 垂直 + 单线”的交叉及交叉点前后 1 格；
// 同 net 导线豁免 1 格间隙，但仍不允许共线重叠或端点/顶点接触。
function foreignContactsValid(state, wireId, expanded, definitionOptions, validation) {
  const { built, meta } = validation || wireContactIndex(state, definitionOptions, wireId);
  if (meta.size === 0) return true;
  const netIds = built.netIdOfWire;
  const netId = netIds[wireId];
  const gates = new Set();
  const requireDeclaredContacts = validation?.requireDeclaredContacts;

  for (let i = 1; i < expanded.length - 1; i += 1) {
    const point = expanded[i];
    const key = pointKeyOf(point);
    const entries = meta.get(key);
    if (!entries) continue;
    let crossing = null;
    let junction = false;
    for (const entry of entries) {
      if (entry.wireId === wireId) continue;
      if (entry.isVertex || entry.isEndpoint) {
        if (!requireDeclaredContacts) continue;
        if (!entry.isEndpoint || !isDeclaredBranchContact(state.wires[entry.wireId], wireId, point)) return false;
        junction = true;
        continue;
      }
      if (crossing) return false;
      crossing = entry;
    }
    if (!crossing) continue;
    if (junction) return false;

    const before = {
      x: Math.sign(point.x - expanded[i - 1].x),
      y: Math.sign(point.y - expanded[i - 1].y)
    };
    const after = {
      x: Math.sign(expanded[i + 1].x - point.x),
      y: Math.sign(expanded[i + 1].y - point.y)
    };

    // 与外来导线接触的这一点必须是本线的直穿点。
    if (before.x !== after.x || before.y !== after.y) {
      return false;
    }
    if (before.x * crossing.dir.x + before.y * crossing.dir.y !== 0) {
      return false;
    }
    gates.add(key);
    gates.add(pointKeyOf({ x: point.x + before.x, y: point.y + before.y }));
    gates.add(pointKeyOf({ x: point.x - before.x, y: point.y - before.y }));
  }

  for (let i = 1; i < expanded.length - 1; i += 1) {
    const point = expanded[i];
    if (gates.has(pointKeyOf(point))) continue;
    if (foreignWireTooClose(meta, netIds, netId, point)) return false;
  }
  return true;
}

function checkMovedWire(state, wireId, points, definitionOptions = {}, validation) {
  const expanded = simpleOrthogonalPoints(points);
  if (!expanded) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const envelope = polylineBounds(points);
  const boundsList = validation?.bounds || componentBoundsList(state, definitionOptions);
  const nearby = boundsList.filter(bounds => bounds &&
    envelope.x <= bounds.x + bounds.w && envelope.x + envelope.w >= bounds.x &&
    envelope.y <= bounds.y + bounds.h && envelope.y + envelope.h >= bounds.y);
  for (let i = 1; i < points.length; i += 1) {
    for (const bounds of nearby) {
      if (segmentOverlapsBoundsEdge(points[i - 1], points[i], bounds)) {
        return reject(REASONS.WIRE_ON_COMPONENT_EDGE);
      }
    }
  }
  if (wireEntersBounds(expanded, envelope, nearby)) {
    return reject(REASONS.BLOCKED_BY_COMPONENT);
  }
  const pinSet = validation?.pins || componentPinKeys(state, definitionOptions);
  for (let i = 1; i < expanded.length - 1; i += 1) {
    if (pinSet.has(pointKeyOf(expanded[i]))) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
  }

  if (!endpointsPreserved(state, wireId, points, { definitions: definitionOptions.definitions })) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  const wire = state.wires[wireId];
  const ends = [
    { end: wire.endA, atStart: true },
    { end: wire.endB, atStart: false }
  ];
  for (const item of ends) {
    const end = item.end;
    if (!end || end.kind === 'pin') {
      continue;
    }
    const point = endpointPoint(points, item.atStart);
    if (!samePoint(point, endpointPoint(wire.points, item.atStart))) {
      if (!movedEndpointValid(state, wireId, end, point, definitionOptions, validation)) {
        return reject(REASONS.ILLEGAL_GEOMETRY);
      }
    }
  }
  if (!foreignContactsValid(state, wireId, expanded, definitionOptions, validation)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  return { ok: true };
}

// 预览：返回候选折线（失败时也尽量带回，便于 UI 画红色虚线）。
export function previewDragWireSegment(state, wireId, segmentIndex, offset, definitionOptions = {}) {
  const wire = state.wires[wireId];
  if (!wire || !Array.isArray(wire.points)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const axis = segmentDragAxis(wire.points, segmentIndex);
  if (!axis) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const raw = axis === 'y' ? (offset && offset.y) : (offset && offset.x);
  if (!Number.isFinite(raw)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  // 只有接引脚的端点不允许移动；free / junction 端点可随线段平移。
  const fixStart = Boolean(wire.endA) && wire.endA.kind === 'pin';
  const fixEnd = Boolean(wire.endB) && wire.endB.kind === 'pin';
  const moved = translateSegment(wire.points, segmentIndex, snapToWireGrid(raw), {
    fixStart,
    fixEnd
  });
  if (!moved) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (fixStart && wire.endA && wire.endA.kind === 'pin') {
    moved.points = escapePinEdge(
      state.components[wire.endA.componentId],
      wire.endA.pinId,
      moved.points,
      true
    , { definitions: definitionOptions.definitions });
  }
  if (fixEnd && wire.endB && wire.endB.kind === 'pin') {
    moved.points = escapePinEdge(
      state.components[wire.endB.componentId],
      wire.endB.pinId,
      moved.points,
      false
    , { definitions: definitionOptions.definitions });
  }
  const original = wire.points;
  if (
    (fixStart && !samePoint(moved.points[0], original[0])) ||
    (fixEnd && !samePoint(moved.points[moved.points.length - 1], original[original.length - 1]))
  ) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (moved.delta === 0) {
    return { ok: true, points: moved.points, delta: 0 };
  }

  const check = checkMovedWire(state, wireId, moved.points, { definitions: definitionOptions.definitions });
  if (!check.ok) {
    return { ok: false, reason: check.reason, points: moved.points };
  }
  return { ok: true, points: moved.points, delta: moved.delta };
}

// 提交：成功才替换线段折线；失败零副作用。
export function dragWireSegment(state, wireId, segmentIndex, offset, definitionOptions = {}) {
  const preview = previewDragWireSegment(state, wireId, segmentIndex, offset, { definitions: definitionOptions.definitions });
  if (!preview.ok) {
    return reject(preview.reason);
  }
  const draft = clone(state);
  const wire = draft.wires[wireId];
  wire.points = JSON.parse(JSON.stringify(preview.points));
  updateJunctionPoint(wire.endA, wire.points[0]);
  updateJunctionPoint(wire.endB, wire.points[wire.points.length - 1]);
  return { ok: true, state: draft, delta: preview.delta, geometryOnly: true };
}

function updateJunctionPoint(end, point) {
  if (end && end.kind === 'junction') {
    end.point = { x: point.x, y: point.y };
  }
}

// ── 悬空端点接空闲引脚 ──────────────────────────────────────────────────────
// 悬空端点移到空白位置或接脚时，固定端和已有 T 点保持锚定。

function wireEnd(wire, side) {
  return side === 'A' ? wire.endA : wire.endB;
}

function wireHasIncomingJunction(state, wireId) {
  for (const id of Object.keys(state.wires)) {
    if (id === wireId) {
      continue;
    }
    const wire = state.wires[id];
    for (const end of [wire.endA, wire.endB]) {
      if (end && end.kind === 'junction' && end.wireId === wireId) {
        return true;
      }
    }
  }
  return false;
}

// points 从固定端指向被拖端。保留到最后一个 T 点之后的第一个布线网格点。
function protectedWirePrefix(state, wireId, points) {
  let lastSegment = -1;
  let lastOffset = 0;
  for (const [id, wire] of Object.entries(state.wires)) {
    if (id === wireId) continue;
    for (const end of [wire.endA, wire.endB]) {
      if (end?.kind !== 'junction' || end.wireId !== wireId) continue;
      const hit = pointOnPolylineInterior(points, end.point);
      if (!hit.on) return null;
      const from = points[hit.index];
      const offset = Math.abs(end.point.x - from.x) + Math.abs(end.point.y - from.y);
      if (hit.index > lastSegment || (hit.index === lastSegment && offset > lastOffset)) {
        lastSegment = hit.index;
        lastOffset = offset;
      }
    }
  }
  if (lastSegment < 0) return null;
  const from = points[lastSegment];
  const to = points[lastSegment + 1];
  const dir = segmentDirection(from, to);
  const step = (Math.floor(lastOffset / WIRE_GRID) + 1) * WIRE_GRID;
  const cut = { x: from.x + dir.x * step, y: from.y + dir.y * step };
  if (!samePoint(cut, to) && !pointOnSegmentInterior(cut, from, to)) return null;
  return points.slice(0, lastSegment + 1).concat(cut);
}

function routeAndCheckWire(routingState, start, targetPoint, options, validate) {
  const routed = route(routingState, start, targetPoint, options);
  if (!routed.ok) return routed;
  const checked = validate(routed.points);
  if (checked.ok) return checked;
  // 首选走线可能合法穿越待合入同一条线的路段，但拼接后会自交。
  const detour = route(routingState, start, targetPoint, { ...options, allowCrossing: false });
  return detour.ok ? validate(detour.points) : checked;
}

function routeHostedWireEnd(state, wireId, side, targetPoint, ignoreNetOf, definitionOptions, validate) {
  const source = state.wires[wireId];
  const ordered = side === 'A' ? source.points.slice().reverse() : source.points;
  for (const candidate of stretchWireCandidates(ordered, false, targetPoint)) {
    const checked = validate(candidate);
    if (checked.ok) return checked;
  }

  const prefix = protectedWirePrefix(state, wireId, ordered);
  if (!prefix) return reject(REASONS.ILLEGAL_GEOMETRY);
  const start = prefix[prefix.length - 1];
  if (samePoint(start, targetPoint)) return validate(prefix);

  const routingState = {
    ...state,
    wires: { ...state.wires, [wireId]: { ...source, points: prefix } }
  };
  return routeAndCheckWire(routingState, start, targetPoint, { ...definitionOptions, ignoreNetOf }, function (tail) {
    return validate(simplify(prefix.concat(tail.slice(1))));
  });
}

function validateHostedWire(state, wireId, points, definitionOptions, validation) {
  const checked = checkMovedWire(state, wireId, points, definitionOptions, validation);
  return checked.ok ? { ok: true, points } : checked;
}

function pinEndFromAnchor(state, anchor, definitionOptions = {}) {
  if (!anchor || anchor.kind !== 'pin') {
    return null;
  }
  const component = state.components[anchor.componentId];
  if (!component) {
    return null;
  }
  try {
    const point = pinWorld(component, anchor.pinId, definitionOptions.definitions);
    return {
      end: { kind: 'pin', componentId: anchor.componentId, pinId: anchor.pinId },
      point
    };
  } catch (err) {
    return null;
  }
}

// 统一的 free 端点移动计划：targetEnd 为 pin/junction 时接线，为 null 时移动到空白点。
// 含 T 点时只重布拖动端一侧，自有 T 点仍保留在直线内部。
function planWireEndMove(state, wireId, side, targetPoint, targetEnd, definitionOptions = {}, options = {}) {
  if (side !== 'A' && side !== 'B') {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const wire = state.wires[wireId];
  if (!wire || !Array.isArray(wire.points) || wire.points.length < 2) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const end = wireEnd(wire, side);
  const allowPinnedSource = Boolean(options && options.allowPinnedSource);
  if (!end || (end.kind !== 'free' && !(allowPinnedSource && end.kind === 'pin'))) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (!isWireGridPoint(targetPoint)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const hasBranches = wireHasIncomingJunction(state, wireId);
  if (hasBranches && (end.kind !== 'free' || targetEnd?.kind === 'junction')) {
    return reject(REASONS.WIRED_OBJECT_LOCKED);
  }

  const nextEnd = targetEnd || { kind: 'free' };
  if (targetEnd && targetEnd.kind === 'junction') {
    const host = junctionHost(state, targetEnd);
    if (targetEnd.wireId === wireId || !host.ok ||
        !movedEndpointValid(state, wireId, targetEnd, targetPoint, definitionOptions)) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    const current = buildNets(state, definitionOptions);
    if (current.netIdOfWire[wireId] === current.netIdOfWire[targetEnd.wireId]) {
      return reject(REASONS.PURE_WIRE_LOOP);
    }
  } else if (targetEnd) {
    if (isPinConnected(state, targetEnd.componentId, targetEnd.pinId)) {
      return reject(REASONS.PIN_ALREADY_CONNECTED);
    }
  } else {
    // 移到空白点：端点不能压在别的导线或引脚上。
    if (!movedEndpointValid(state, wireId, { kind: 'free' }, targetPoint, { definitions: definitionOptions.definitions })) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    const currentPoint = side === 'A' ? wire.points[0] : wire.points[wire.points.length - 1];
    if (samePoint(currentPoint, targetPoint)) {
      // free 端点原地释放是幂等操作；pin 端点原地释放会得到“压在引脚上的悬空端”，拒绝。
      if (end.kind !== 'free') {
        return reject(REASONS.ILLEGAL_GEOMETRY);
      }
      return { ok: true, points: wire.points.map(function (point) {
        return { x: point.x, y: point.y };
      }) };
    }
  }

  // 拓扑预检（多驱动 / 反馈环），避免为必然失败的连接跑布线。
  const topologyDraft = clone(state);
  if (side === 'A') {
    topologyDraft.wires[wireId].endA = clone(nextEnd);
  } else {
    topologyDraft.wires[wireId].endB = clone(nextEnd);
  }
  const built = buildNets(topologyDraft, { definitions: definitionOptions.definitions });
  const net = built.nets.find(function (candidate) {
    return candidate.wireIds.indexOf(wireId) !== -1;
  });
  if (net && net.driverPins.length >= 2) {
    return reject(REASONS.SECOND_DRIVER);
  }

  const otherSide = side === 'A' ? 'B' : 'A';
  const otherEnd = wireEnd(wire, otherSide);
  const otherPoint = endPointOf(state, otherEnd, wire, otherSide, { definitions: definitionOptions.definitions });
  if (!otherPoint || !isWireGridPoint(otherPoint)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (samePoint(otherPoint, targetPoint)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  if (hasBranches) {
    const validation = { ...wireValidation(topologyDraft, definitionOptions), requireDeclaredContacts: true };
    const selected = routeHostedWireEnd(state, wireId, side, targetPoint, net?.wireIds || [], definitionOptions, function (ordered) {
      const points = side === 'A' ? ordered.slice().reverse() : ordered;
      return validateHostedWire(topologyDraft, wireId, points, definitionOptions, validation);
    });
    if (!selected.ok) return selected;
    topologyDraft.wires[wireId].points = selected.points;
    return junctionsValid(topologyDraft) && wireCellsValid(topologyDraft, definitionOptions, validation.bounds)
      ? selected
      : reject(REASONS.ILLEGAL_GEOMETRY);
  }

  const ignoreNetOf = collectNetWireIds(state, [otherEnd, targetEnd], { definitions: definitionOptions.definitions });
  const routingState = {
    nextId: state.nextId,
    components: state.components,
    wires: Object.assign({}, state.wires)
  };
  delete routingState.wires[wireId];

  const routed = route(routingState, otherPoint, targetPoint, Object.assign({}, {
    allowTouching: [otherPoint, targetPoint],
    ignoreNetOf
  }, { definitions: definitionOptions.definitions }));
  if (!routed.ok) {
    return reject(routed.reason);
  }

  if (targetEnd && targetEnd.kind === 'junction' &&
      !isPerpendicularToHost(routed.points, false, junctionHost(state, targetEnd).host)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  if (otherEnd && otherEnd.kind === 'junction') {
    const host = state.wires[otherEnd.wireId];
    if (!host) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    const hit = pointOnPolylineInterior(host.points, otherEnd.point);
    if (!hit.on) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    // route 从固定的另一端起步，因此检查起点侧。
    if (!isPerpendicularToHost(routed.points, true, { points: host.points, index: hit.index })) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
  }

  // route 总是从固定端出发到目标点；折线顺序必须与 endA→endB 一致。
  const points = side === 'A' ? routed.points.slice().reverse() : routed.points;

  const draft = topologyDraft;
  const draftWire = draft.wires[wireId];
  draftWire.points = points;

  if (!junctionsValid(draft) || !wireCellsValid(draft, { definitions: definitionOptions.definitions })) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const others = Object.assign({}, draft.wires);
  delete others[wireId];
  const temp = { nextId: draft.nextId, components: draft.components, wires: others };
  if (!validateCrossings(temp, draftWire.points)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  return { ok: true, points };
}

export function previewAttachFreeEnd(state, wireId, side, anchor, definitionOptions = {}) {
  const target = anchor && anchor.kind === 'junction'
    ? { point: anchor.point, end: { kind: 'junction', wireId: anchor.wireId, point: anchor.point } }
    : pinEndFromAnchor(state, anchor, { definitions: definitionOptions.definitions });
  if (!target) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  return planWireEndMove(state, wireId, side, target.point, target.end, { definitions: definitionOptions.definitions });
}

function applyWireEndPlan(state, wireId, points, side, nextEnd) {
  const draft = clone(state);
  const wire = draft.wires[wireId];
  wire.points = clone(points);
  if (nextEnd) wire[side === 'A' ? 'endA' : 'endB'] = clone(nextEnd);
  return draft;
}

export function attachFreeEnd(state, wireId, side, anchor, definitionOptions = {}) {
  const preview = previewAttachFreeEnd(state, wireId, side, anchor, { definitions: definitionOptions.definitions });
  if (!preview.ok) {
    return reject(preview.reason);
  }
  const nextEnd = anchor.kind === 'junction'
    ? { kind: 'junction', wireId: anchor.wireId, point: anchor.point }
    : { kind: 'pin', componentId: anchor.componentId, pinId: anchor.pinId };
  const draft = applyWireEndPlan(state, wireId, preview.points, side, nextEnd);
  return { ok: true, state: draft };
}

export function previewMoveFreeEnd(state, wireId, side, point, definitionOptions = {}) {
  return planWireEndMove(state, wireId, side, point, null, { definitions: definitionOptions.definitions });
}

export function moveFreeEnd(state, wireId, side, point, definitionOptions = {}) {
  const preview = previewMoveFreeEnd(state, wireId, side, point, { definitions: definitionOptions.definitions });
  if (!preview.ok) {
    return reject(preview.reason);
  }
  const draft = applyWireEndPlan(state, wireId, preview.points);
  return { ok: true, state: draft, geometryOnly: true };
}

// ── 把接在引脚上的端点拖开 ──────────────────────────────────────────────────
// 与 free 端点移动共用重布逻辑，但允许起点是 pin。目标为空白点时端点变 free；
// 目标为另一个空闲 pin 时直接重接过去。目标/几何失败时零副作用。

export function previewDetachPinEnd(state, wireId, side, point, targetEnd, definitionOptions = {}) {
  const wire = state.wires[wireId];
  const end = wire && (side === 'A' ? wire.endA : wire.endB);
  if (!end || end.kind !== 'pin') {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  return planWireEndMove(state, wireId, side, point, targetEnd || null, {
    definitions: definitionOptions.definitions
  }, { allowPinnedSource: true });
}

export function detachPinEnd(state, wireId, side, point, targetEnd, definitionOptions = {}) {
  const preview = previewDetachPinEnd(state, wireId, side, point, targetEnd, {
    definitions: definitionOptions.definitions
  });
  if (!preview.ok) {
    return reject(preview.reason);
  }
  const nextEnd = targetEnd || { kind: 'free' };
  const draft = applyWireEndPlan(state, wireId, preview.points, side, nextEnd);
  return { ok: true, state: draft, id: wireId, points: preview.points };
}


// ── 空白处自由画线 ──────────────────────────────────────────────────────────
// 只接受水平/垂直的直线；两个端点都是 free。几何规则与其它导线一致：
// 不穿元件格、不压引脚、不与其他导线重叠/过近；允许垂直穿越。

const FREE_WIRE_ID = '__free_wire__';

function checkFreeWire(state, points, definitionOptions = {}) {
  const expanded = simpleOrthogonalPoints(points);
  if (!expanded) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (polylineOverlapsComponentEdge(points, Object.values(state.components), { definitions: definitionOptions.definitions })) {
    return reject(REASONS.WIRE_ON_COMPONENT_EDGE);
  }

  for (const point of expanded) {
    for (const component of Object.values(state.components)) {
      if (pointInBounds(point, componentBounds(component, definitionOptions.definitions), false)) {
        return reject(REASONS.BLOCKED_BY_COMPONENT);
      }
    }
  }

  const pinSet = new Set();
  for (const component of Object.values(state.components)) {
    for (const def of componentPins(component, definitionOptions.definitions) || []) {
      pinSet.add(pointKeyOf(pinWorld(component, def.id, definitionOptions.definitions)));
    }
  }
  for (const point of expanded) {
    if (pinSet.has(pointKeyOf(point))) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
  }

  if (!foreignContactsValid(state, FREE_WIRE_ID, expanded, definitionOptions)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (!movedEndpointValid(state, FREE_WIRE_ID, { kind: 'free' }, points[0], { definitions: definitionOptions.definitions }) ||
      !movedEndpointValid(state, FREE_WIRE_ID, { kind: 'free' }, points[points.length - 1], { definitions: definitionOptions.definitions })) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  return { ok: true };
}

export function previewCreateFreeWire(state, start, end, definitionOptions = {}) {
  if (!isWireGridPoint(start) || !isWireGridPoint(end)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (start.x !== end.x && start.y !== end.y) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (samePoint(start, end)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const points = [
    { x: start.x, y: start.y },
    { x: end.x, y: end.y }
  ];
  const check = checkFreeWire(state, points, { definitions: definitionOptions.definitions });
  if (!check.ok) {
    return reject(check.reason);
  }
  return { ok: true, points };
}

export function createFreeWire(state, start, end, definitionOptions = {}) {
  const preview = previewCreateFreeWire(state, start, end, { definitions: definitionOptions.definitions });
  if (!preview.ok) {
    return reject(preview.reason);
  }
  const draft = clone(state);
  const id = addWire(
    draft,
    JSON.parse(JSON.stringify(preview.points)),
    { kind: 'free' },
    { kind: 'free' }
  );
  return { ok: true, state: draft, id, points: preview.points };
}

// ── 从管脚/线身起笔画悬空线 ─────────────────────────────────────────────────
// 起点必须是有稳定拓扑锚点的 pin 或 junction；终点是空白网格点并保持 free。
// 与“空白处自由画线”不同，本流程复用自动布线，因此允许 L 形或绕障折线。
// 终点不会自动接管附近的元件或导线，仍由用户后续拖动端点接线。

function planAnchoredFreeWire(state, anchor, point, definitionOptions = {}) {
  if (!anchor || (anchor.kind !== 'pin' && anchor.kind !== 'junction')) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const startPoint = endPoint(state, anchor, { definitions: definitionOptions.definitions });
  if (!startPoint || !isWireGridPoint(startPoint) || !isWireGridPoint(point)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (samePoint(startPoint, point)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  // 拓扑预检：已接线引脚、多驱动等与普通接线保持同一拒绝顺序。
  const topology = checkConnect(state, anchor, { kind: 'free' }, { definitions: definitionOptions.definitions });
  if (!topology.ok) {
    return reject(topology.reason);
  }

  // 临时把新线挂到拓扑上，让 free 端点与“本线所属 net”比较净距；
  // 若直接用不存在的 wireId，junction 起点会把宿主当成外来导线而误拒。
  const probe = clone(state);
  const probeId = addWire(probe, [], clone(anchor), { kind: 'free' });
  if (!movedEndpointValid(probe, probeId, { kind: 'free' }, point, { definitions: definitionOptions.definitions })) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  const ignoreNetOf = collectNetWireIds(state, [anchor], { definitions: definitionOptions.definitions });
  const routed = route(state, startPoint, point, Object.assign({}, {
    allowTouching: [startPoint, point],
    ignoreNetOf
  }, { definitions: definitionOptions.definitions }));
  if (!routed.ok) {
    return reject(routed.reason);
  }
  if (polylineOverlapsComponentEdge(routed.points, Object.values(state.components), { definitions: definitionOptions.definitions })) {
    return reject(REASONS.WIRE_ON_COMPONENT_EDGE);
  }

  if (anchor.kind === 'junction') {
    const host = state.wires[anchor.wireId];
    if (!host) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    const hit = pointOnPolylineInterior(host.points, anchor.point);
    if (!hit.on || typeof hit.index !== 'number') {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    // 新线从宿主内部引出时必须垂直于宿主，否则会与宿主共线重叠。
    if (!isPerpendicularToHost(routed.points, true, { points: host.points, index: hit.index })) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
  }

  return { ok: true, points: routed.points };
}

export function previewCreateAnchoredFreeWire(state, anchor, point, definitionOptions = {}) {
  return planAnchoredFreeWire(state, anchor, point, { definitions: definitionOptions.definitions });
}

export function createAnchoredFreeWire(state, anchor, point, definitionOptions = {}) {
  const preview = previewCreateAnchoredFreeWire(state, anchor, point, { definitions: definitionOptions.definitions });
  if (!preview.ok) {
    return reject(preview.reason);
  }
  const draft = clone(state);
  const id = addWire(
    draft,
    JSON.parse(JSON.stringify(preview.points)),
    clone(anchor),
    { kind: 'free' }
  );
  return { ok: true, state: draft, id, points: preview.points };
}

// ── 两个悬空端点合并 ────────────────────────────────────────────────────────
// 拖动一条线的 free 端落到另一条线的 free 端时，把两条线拼成一条：
// 保留拖动线另一端作为合并后 endA，目标线另一端作为 endB，目标线被删除。
// 目标线上的 T 点改为锚在合并后的宿主线，坐标保留。

function freeSideInfo(state, wireId, side) {
  if (side !== 'A' && side !== 'B') {
    return null;
  }
  const wire = state.wires[wireId];
  if (!wire || !Array.isArray(wire.points) || wire.points.length < 2) {
    return null;
  }
  const end = side === 'A' ? wire.endA : wire.endB;
  if (!end || end.kind !== 'free') {
    return null;
  }
  const point = side === 'A' ? wire.points[0] : wire.points[wire.points.length - 1];
  if (!isWireGridPoint(point)) {
    return null;
  }
  return {
    wire,
    end,
    point: { x: point.x, y: point.y },
    otherSide: side === 'A' ? 'B' : 'A'
  };
}

function planMergeFreeEnds(state, wireId, side, targetWireId, targetSide, definitionOptions = {}) {
  const defs = { definitions: definitionOptions.definitions };
  if (!wireId || !targetWireId || wireId === targetWireId) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const source = freeSideInfo(state, wireId, side);
  const target = freeSideInfo(state, targetWireId, targetSide);
  if (!source || !target) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  const sourceHasBranches = wireHasIncomingJunction(state, wireId);
  const hasBranches = sourceHasBranches || wireHasIncomingJunction(state, targetWireId);

  const built = buildNets(state, defs);
  if (built.netIdOfWire[wireId] === built.netIdOfWire[targetWireId]) {
    return reject(REASONS.PURE_WIRE_LOOP);
  }

  const sourceOtherEnd = source.otherSide === 'A' ? source.wire.endA : source.wire.endB;
  const targetOtherEnd = target.otherSide === 'A' ? target.wire.endA : target.wire.endB;
  const sourceOtherPoint = endPointOf(state, sourceOtherEnd, source.wire, source.otherSide, defs);
  const targetOtherPoint = endPointOf(state, targetOtherEnd, target.wire, target.otherSide, defs);
  if (
    !sourceOtherPoint ||
    !targetOtherPoint ||
    !isWireGridPoint(sourceOtherPoint) ||
    !isWireGridPoint(targetOtherPoint)
  ) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  // 拓扑先于布线：合并两条线可能把两个驱动 net 接在一起。
  const draft = clone(state);
  draft.wires[wireId].endA = clone(sourceOtherEnd);
  draft.wires[wireId].endB = clone(targetOtherEnd);
  delete draft.wires[targetWireId];
  for (const wire of Object.values(draft.wires)) {
    for (const end of [wire.endA, wire.endB]) {
      if (end?.kind === 'junction' && end.wireId === targetWireId) end.wireId = wireId;
    }
  }
  const next = buildNets(draft, defs);
  const mergedNet = next.nets.find(function (net) {
    return net.wireIds.indexOf(wireId) !== -1;
  });
  if (mergedNet && mergedNet.driverPins.length >= 2) {
    return reject(REASONS.SECOND_DRIVER);
  }

  // 目标线从 free 端朝向另一端拼到拖动线后面；中间重复点交给 simplify。
  const targetPoints = targetSide === 'B'
    ? target.wire.points.slice().reverse()
    : target.wire.points;
  const suffix = targetPoints.slice(1);
  const validation = hasBranches ? { ...wireValidation(draft, defs), requireDeclaredContacts: true } : null;
  const ignoreNetOf = hasBranches && mergedNet
    ? mergedNet.wireIds.concat(targetWireId)
    : collectNetWireIds(state, [sourceOtherEnd], defs);
  const join = function (prefix) {
    return simplify(prefix.concat(suffix));
  };
  const expandedTarget = hasBranches ? simpleOrthogonalPoints(targetPoints) : null;
  if (hasBranches && !expandedTarget) return reject(REASONS.ILLEGAL_GEOMETRY);
  const targetFootprint = expandedTarget && new Set(expandedTarget.slice(1).map(pointKeyOf));
  const validateJoin = function (prefix) {
    // 两段只能在 free 合并点相接。先检验再简化，避免共线折返被消掉。
    if (polylinePoints(prefix).some(point => targetFootprint.has(pointKeyOf(point)))) {
      return reject(REASONS.ILLEGAL_GEOMETRY);
    }
    return validateHostedWire(draft, wireId, join(prefix), defs, validation);
  };

  let selected;
  if (sourceHasBranches) {
    selected = routeHostedWireEnd(state, wireId, side, target.point, ignoreNetOf, defs, validateJoin);
  } else {
    const routingState = { ...state, wires: { ...state.wires } };
    delete routingState.wires[wireId];
    const routeOptions = { ...defs, allowTouching: [sourceOtherPoint, target.point], ignoreNetOf };
    selected = hasBranches
      ? routeAndCheckWire(routingState, sourceOtherPoint, target.point, routeOptions, validateJoin)
      : route(routingState, sourceOtherPoint, target.point, routeOptions);
  }
  if (!selected.ok) return reject(selected.reason);
  const points = hasBranches ? selected.points : join(selected.points);

  const expanded = simpleOrthogonalPoints(points);
  if (!expanded) return reject(REASONS.ILLEGAL_GEOMETRY);
  if (!hasBranches && polylineOverlapsComponentEdge(points, Object.values(draft.components), defs)) {
    return reject(REASONS.WIRE_ON_COMPONENT_EDGE);
  }
  draft.wires[wireId].points = clone(points);
  if (
    !junctionsValid(draft) ||
    !wireCellsValid(draft, defs, validation?.bounds) ||
    (!hasBranches && !endpointsPreserved(draft, wireId, points, defs))
  ) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }
  if (!hasBranches && !foreignContactsValid(draft, wireId, expanded, defs)) {
    return reject(REASONS.ILLEGAL_GEOMETRY);
  }

  return {
    ok: true,
    points,
    endA: sourceOtherEnd,
    endB: targetOtherEnd,
    removeWireId: targetWireId,
    state: draft
  };
}

export function previewMergeFreeEnds(state, wireId, side, targetWireId, targetSide, definitionOptions = {}) {
  const plan = planMergeFreeEnds(state, wireId, side, targetWireId, targetSide, {
    definitions: definitionOptions.definitions
  });
  if (!plan.ok) return plan;
  const { state: _draft, ...preview } = plan;
  return preview;
}

export function mergeFreeEnds(state, wireId, side, targetWireId, targetSide, definitionOptions = {}) {
  const plan = planMergeFreeEnds(state, wireId, side, targetWireId, targetSide, {
    definitions: definitionOptions.definitions
  });
  if (!plan.ok) return plan;
  return {
    ok: true,
    state: plan.state,
    id: wireId,
    removedId: plan.removeWireId,
    points: plan.points
  };
}
