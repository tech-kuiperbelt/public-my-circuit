// 职责：接线命中判定的纯函数（无 DOM）；输入世界坐标，输出锚点或折线点。
import {
  WIRE_GRID,
  componentBounds,
  componentPins,
  pinWorld,
  snapToWireGrid
} from '../core/geometry.js';
import { isPinConnected } from '../core/validate.js';
import { frameLabelRect, frameScreenRect } from './frame.js';

function scaleOf(view) {
  const scale = view && Number.isFinite(view.scale) ? view.scale : 1;
  return scale > 0 ? scale : 1;
}

// 屏幕 10px 换算到世界单位，下限 2 个世界单位。
export function hitTolerance(view) {
  return Math.max(2, 10 / scaleOf(view));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function samePoint(a, b) {
  return a.x === b.x && a.y === b.y;
}

// TOGGLE 中心圆形开关的相对半径；渲染与命中判定共用，避免交互区域漂移。
export const TOGGLE_SWITCH_RADIUS_RATIO = 0.27;

function hitCenterSwitch(component, world, type, definitionOptions) {
  if (!component || component.type !== type || !world) {
    return false;
  }
  const bounds = componentBounds(component, definitionOptions.definitions);
  if (!bounds) {
    return false;
  }
  const radius = Math.min(bounds.w, bounds.h) * TOGGLE_SWITCH_RADIUS_RATIO;
  const centerX = bounds.x + bounds.w / 2;
  const centerY = bounds.y + bounds.h / 2;
  return Math.hypot(world.x - centerX, world.y - centerY) <= radius;
}

// 仅 Toggle 中心开关参与点击翻转；元件其余区域仍用于选择/拖动。
export function hitToggleSwitch(component, world, definitionOptions = {}) {
  return hitCenterSwitch(component, world, 'TOGGLE', definitionOptions);
}

// BUTTON 与 TOGGLE 共用中心圆半径；只有按下/按住该区域才触发按钮。
export function hitButtonSwitch(component, world, definitionOptions = {}) {
  return hitCenterSwitch(component, world, 'BUTTON', definitionOptions);
}

function nearestPinWhere(state, view, world, wantConnected, definitionOptions = {}) {
  const tolerance = hitTolerance(view);
  let best = null;
  for (const componentId of Object.keys(state.components)) {
    const component = state.components[componentId];
    const defs = componentPins(component, definitionOptions.definitions) || [];
    for (const def of defs) {
      const point = pinWorld(component, def.id, definitionOptions.definitions);
      const dist = distance(world, point);
      if (dist > tolerance) {
        continue;
      }
      const connected = isPinConnected(state, componentId, def.id);
      if (wantConnected !== undefined && connected !== wantConnected) {
        continue;
      }
      if (!best || dist < best.dist) {
        best = {
          anchor: { kind: 'pin', componentId, pinId: def.id, point },
          connected,
          dist
        };
      }
    }
  }
  return best;
}

// 标注管脚：寻找最近的元件引脚或悬空导线端点，同距离时优先引脚。
export function nearestAnnotatable(state, view, world, definitionOptions = {}) {
  const tolerance = hitTolerance(view);
  const pin = nearestPinWhere(state, view, world, undefined, definitionOptions);
  let best = pin ? {
    binding: { kind: 'pin', componentId: pin.anchor.componentId, pinId: pin.anchor.pinId },
    point: pin.anchor.point,
    dist: pin.dist
  } : null;
  for (const wireId of Object.keys(state.wires || {})) {
    const wire = state.wires[wireId];
    const points = wire && wire.points;
    if (!points || points.length < 2) continue;
    const ends = [
      { side: 'A', end: wire.endA, point: points[0] },
      { side: 'B', end: wire.endB, point: points[points.length - 1] }
    ];
    for (const item of ends) {
      if (!item.end || item.end.kind !== 'free') continue;
      const dist = distance(world, item.point);
      if (dist > tolerance) continue;
      if (!best || dist < best.dist) {
        best = {
          binding: { kind: 'wire', wireId, end: item.side },
          point: { x: item.point.x, y: item.point.y },
          dist
        };
      }
    }
  }
  return best ? { binding: best.binding, point: best.point } : null;
}

// 最近的引脚（不区分是否已接线），附带 connected 标记。
export function nearestPin(state, view, world, definitionOptions = {}) {
  const best = nearestPinWhere(state, view, world, undefined, { definitions: definitionOptions.definitions });
  if (!best) {
    return null;
  }
  return { anchor: best.anchor, connected: best.connected, dist: best.dist };
}

// 悬空画线：按拖动的主方向吸附成水平或垂直，长度取主方向的整数格。
export function freeLineEnd(start, world) {
  const x = snapToWireGrid(world.x);
  const y = snapToWireGrid(world.y);
  if (Math.abs(x - start.x) >= Math.abs(y - start.y)) {
    return { x, y: start.y };
  }
  return { x: start.x, y };
}

// 框选：与矩形相交的元件 id（屏幕坐标）。只框元件，不框导线。
export function componentsInRect(state, view, rect, definitionOptions = {}) {
  const scale = view && Number.isFinite(view.scale) ? view.scale : 1;
  const pan = view && view.pan ? view.pan : { x: 0, y: 0 };
  const left = Math.min(rect.x1, rect.x2);
  const right = Math.max(rect.x1, rect.x2);
  const top = Math.min(rect.y1, rect.y2);
  const bottom = Math.max(rect.y1, rect.y2);
  const ids = [];
  for (const id of Object.keys(state.components)) {
    const component = state.components[id];
    const bounds = componentBounds(component, definitionOptions.definitions);
    const x0 = bounds.x * scale + pan.x;
    const y0 = bounds.y * scale + pan.y;
    const x1 = (bounds.x + bounds.w) * scale + pan.x;
    const y1 = (bounds.y + bounds.h) * scale + pan.y;
    if (x1 > left && x0 < right && y1 > top && y0 < bottom) {
      ids.push(id);
    }
  }
  return ids;
}

// 框选：任意线段与矩形相交即选中整条导线（屏幕坐标，边界包含）。
export function wiresInRect(state, view, rect) {
  const scale = view && Number.isFinite(view.scale) ? view.scale : 1;
  const pan = view && view.pan ? view.pan : { x: 0, y: 0 };
  const left = Math.min(rect.x1, rect.x2);
  const right = Math.max(rect.x1, rect.x2);
  const top = Math.min(rect.y1, rect.y2);
  const bottom = Math.max(rect.y1, rect.y2);
  const ids = [];
  for (const id of Object.keys(state.wires)) {
    const wire = state.wires[id];
    const points = wire && wire.points;
    if (!points || points.length < 2) {
      continue;
    }
    const box = { x: left, y: top, width: right - left, height: bottom - top };
    const screenPoints = points.map(point => ({
      x: point.x * scale + pan.x,
      y: point.y * scale + pan.y
    }));
    if (screenPoints.some((point, index) => index > 0 &&
      segmentIntersectsRect(screenPoints[index - 1], point, box))) {
      ids.push(id);
    }
  }
  return ids;
}


// 分组框命中：默认只认边框和右下角标签；右键菜单可用 includeInterior 认内部空白。
export function hitFrame(state, view, screen, includeInterior) {
  const frames = state.frames || {};
  const ids = Object.keys(frames);
  const scale = view && Number.isFinite(view.scale) ? view.scale : 1;
  const tolerance = Math.max(3, 8 / (scale > 0 ? scale : 1));
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const frame = frames[ids[i]];
    const rect = frameScreenRect(frame, view);
    if (rect.width <= 0 || rect.height <= 0) {
      continue;
    }
    const label = frameLabelRect(frame, view);
    if (
      screen.x >= label.x &&
      screen.x <= label.x + label.width &&
      screen.y >= label.y &&
      screen.y <= label.y + label.height
    ) {
      return ids[i];
    }
    const insideOuter =
      screen.x >= rect.x - tolerance &&
      screen.x <= rect.x + rect.width + tolerance &&
      screen.y >= rect.y - tolerance &&
      screen.y <= rect.y + rect.height + tolerance;
    if (!insideOuter) {
      continue;
    }
    const nearBorder =
      Math.abs(screen.x - rect.x) <= tolerance ||
      Math.abs(screen.x - (rect.x + rect.width)) <= tolerance ||
      Math.abs(screen.y - rect.y) <= tolerance ||
      Math.abs(screen.y - (rect.y + rect.height)) <= tolerance;
    const inInterior =
      Boolean(includeInterior) &&
      screen.x >= rect.x &&
      screen.x <= rect.x + rect.width &&
      screen.y >= rect.y &&
      screen.y <= rect.y + rect.height;
    if (nearBorder || inInterior) {
      return ids[i];
    }
  }
  return null;
}


function rectsIntersect(a, b) {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function orientation(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function pointOnSegmentRectEdge(p, a, b) {
  return (
    p.x >= Math.min(a.x, b.x) &&
    p.x <= Math.max(a.x, b.x) &&
    p.y >= Math.min(a.y, b.y) &&
    p.y <= Math.max(a.y, b.y)
  );
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
      ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) {
    return true;
  }
  if (o1 === 0 && pointOnSegmentRectEdge(c, a, b)) return true;
  if (o2 === 0 && pointOnSegmentRectEdge(d, a, b)) return true;
  if (o3 === 0 && pointOnSegmentRectEdge(a, c, d)) return true;
  if (o4 === 0 && pointOnSegmentRectEdge(b, c, d)) return true;
  return false;
}

function segmentIntersectsRect(a, b, rect) {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height }
  ];
  for (const p of [a, b]) {
    if (
      p.x >= rect.x && p.x <= rect.x + rect.width &&
      p.y >= rect.y && p.y <= rect.y + rect.height
    ) {
      return true;
    }
  }
  for (let i = 0; i < corners.length; i += 1) {
    const c = corners[i];
    const d = corners[(i + 1) % corners.length];
    if (segmentsIntersect(a, b, c, d)) {
      return true;
    }
  }
  return false;
}

// 分组框框选：框选矩形与边框或右下角标签相交；透明内部不选中。
export function framesInRect(state, view, rect) {
  const frames = state.frames || {};
  const ids = [];
  const box = {
    x: Math.min(rect.x1, rect.x2),
    y: Math.min(rect.y1, rect.y2),
    width: Math.abs(rect.x2 - rect.x1),
    height: Math.abs(rect.y2 - rect.y1)
  };
  for (const id of Object.keys(frames)) {
    const frame = frames[id];
    const area = frameScreenRect(frame, view);
    if (area.width <= 0 || area.height <= 0) {
      continue;
    }
    const label = frameLabelRect(frame, view);
    if (rectsIntersect(label, box)) {
      ids.push(id);
      continue;
    }
    const corners = [
      { x: area.x, y: area.y },
      { x: area.x + area.width, y: area.y },
      { x: area.x + area.width, y: area.y + area.height },
      { x: area.x, y: area.y + area.height }
    ];
    let hit = false;
    for (let i = 0; i < corners.length && !hit; i += 1) {
      hit = segmentIntersectsRect(corners[i], corners[(i + 1) % corners.length], box);
    }
    if (hit) {
      ids.push(id);
    }
  }
  return ids;
}

// 最近的悬空端点（free）；返回导线、端侧与端点坐标。
// options.excludeWireId 用于拖动某条线端点时排除它自身。
export function nearestFreeEnd(state, view, world, options = {}) {
  return nearestWireEnd(state, world, 'free', hitTolerance(view), options.excludeWireId);
}

export function nearestJunctionEnd(state, view, world) {
  // 命中区与可见 T 点相近，避免盖住相邻网格线的线身操作。
  const tolerance = Math.min(WIRE_GRID / 2, 5 / scaleOf(view));
  return nearestWireEnd(state, world, 'junction', tolerance);
}

function nearestWireEnd(state, world, kind, tolerance, excludeWireId) {
  let best = null;
  for (const wireId of Object.keys(state.wires)) {
    if (wireId === excludeWireId) {
      continue;
    }
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
      if (item.end?.kind !== kind) {
        continue;
      }
      const dist = distance(world, item.point);
      if (dist <= tolerance && (!best || dist < best.dist)) {
        best = {
          wireId,
          side: item.side,
          point: item.point,
          dist
        };
      }
    }
  }
  return best;
}

// 最近的线身投影 4 单位网格点；只接受严格段内部、距两端至少一个网格步长的点。
export function nearestWirePoint(state, view, world) {
  const tolerance = hitTolerance(view);
  let best = null;
  for (const wireId of Object.keys(state.wires)) {
    const wire = state.wires[wireId];
    const points = wire && wire.points;
    if (!points || points.length < 2) {
      continue;
    }

    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      let candidate = null;

      if (a.y === b.y && a.x !== b.x) {
        const min = Math.min(a.x, b.x);
        const max = Math.max(a.x, b.x);
        const from = Math.ceil(min / WIRE_GRID) * WIRE_GRID;
        const to = Math.floor(max / WIRE_GRID) * WIRE_GRID;
        const first = from === min ? from + WIRE_GRID : from;
        const last = to === max ? to - WIRE_GRID : to;
        if (first > last) {
          continue;
        }
        const x = Math.max(first, Math.min(last, snapToWireGrid(world.x)));
        candidate = { x, y: a.y };
      } else if (a.x === b.x && a.y !== b.y) {
        const min = Math.min(a.y, b.y);
        const max = Math.max(a.y, b.y);
        const from = Math.ceil(min / WIRE_GRID) * WIRE_GRID;
        const to = Math.floor(max / WIRE_GRID) * WIRE_GRID;
        const first = from === min ? from + WIRE_GRID : from;
        const last = to === max ? to - WIRE_GRID : to;
        if (first > last) {
          continue;
        }
        const y = Math.max(first, Math.min(last, snapToWireGrid(world.y)));
        candidate = { x: a.x, y };
      } else {
        continue;
      }

      const dist = distance(world, candidate);
      if (dist > tolerance) {
        continue;
      }
      if (!best || dist < best.dist) {
        best = {
          anchor: { kind: 'junction', wireId, point: candidate },
          dist
        };
      }
    }
  }
  return best;
}

// 命中优先级：未接线引脚 > 线身 > 已接线引脚。
export function resolveAnchor(state, view, world, definitionOptions = {}) {
  const unconnected = nearestPinWhere(state, view, world, false, { definitions: definitionOptions.definitions });
  if (unconnected) {
    return unconnected.anchor;
  }
  const wire = nearestWirePoint(state, view, world);
  if (wire) {
    return wire.anchor;
  }
  const connected = nearestPinWhere(state, view, world, true, { definitions: definitionOptions.definitions });
  if (connected) {
    return connected.anchor;
  }
  return null;
}

// L 形橡皮筋：先横后竖，去掉重复点与共线中间点。
export function rubberPoints(start, cursor) {
  if (!start || !cursor) {
    return [];
  }
  const raw = [
    { x: start.x, y: start.y },
    { x: cursor.x, y: start.y },
    { x: cursor.x, y: cursor.y }
  ];

  const deduped = [];
  for (const point of raw) {
    if (deduped.length === 0 || !samePoint(deduped[deduped.length - 1], point)) {
      deduped.push(point);
    }
  }

  if (deduped.length <= 2) {
    return deduped;
  }

  const out = [deduped[0]];
  for (let i = 1; i < deduped.length - 1; i += 1) {
    const a = out[out.length - 1];
    const b = deduped[i];
    const c = deduped[i + 1];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross !== 0) {
      out.push(b);
    }
  }
  out.push(deduped[deduped.length - 1]);
  return out;
}

export function pointKey(point) {
  if (!point) {
    return '';
  }
  return point.x + ',' + point.y;
}
