// 职责：世界/屏幕坐标换算（纯函数）+ Canvas 渲染。
import {
  CELL,
  WIRE_GRID,
  componentBounds,
  componentDefinition,
  componentPins,
  pinWorld,
  slotCount,
  slotOffset
} from '../core/geometry.js';
import { findCrossings } from '../core/wire.js';
import { getComponentIcon } from './component-icons.js';
import {
  FRAME_LABEL_FONT,
  frameColor,
  frameLabel,
  frameLabelRect,
  frameLabelTextLayout,
  frameScreenRect
} from './frame.js';
import { TOGGLE_SWITCH_RADIUS_RATIO } from './hit.js';
import { getOscillationHighlight, oscillationPulse } from './oscillation-highlight.js';

export const MIN_SCALE = 0.5;
export const MAX_SCALE = 6;

const BRIDGE_SPAN = WIRE_GRID / 2;
const BRIDGE_LIFT = WIRE_GRID * 0.4;

const PIN_LABEL_FONT = '10px sans-serif';
const PIN_LABEL_GAP = 6;
const PIN_LABEL_HEIGHT = 12;
const PIN_LABEL_PAD = 2;
const PIN_RADIUS = 4;
const PIN_STROKE_WIDTH = 2;
const PIN_HIGH_COLOR = '#ffd166';
const PIN_VALUE_INWARD = {
  top: { x: 0, y: 1 },
  right: { x: -1, y: 0 },
  bottom: { x: 0, y: -1 },
  left: { x: 1, y: 0 }
};
// 最密集的管脚相隔一个布线网格；包含描边的标记直径达到间距时才显示。
const PIN_MIN_SCALE = (PIN_RADIUS * 2 + PIN_STROKE_WIDTH) / WIRE_GRID;
// 顺时针旋转后各边的顺序：上 -> 右 -> 下 -> 左。
const PIN_SIDE_ORDER = ['top', 'right', 'bottom', 'left'];

export function clampScale(scale) {
  if (!Number.isFinite(scale)) {
    return 1;
  }
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function worldToScreen(point, view) {
  const scale = view && Number.isFinite(view.scale) ? view.scale : 1;
  const pan = view && view.pan ? view.pan : { x: 0, y: 0 };
  return {
    x: point.x * scale + pan.x,
    y: point.y * scale + pan.y
  };
}

export function screenToWorld(point, view) {
  const scale = view && Number.isFinite(view.scale) ? view.scale : 1;
  const pan = view && view.pan ? view.pan : { x: 0, y: 0 };
  return {
    x: (point.x - pan.x) / scale,
    y: (point.y - pan.y) / scale
  };
}

// 以屏幕点为中心缩放：缩放前后该屏幕点对应的世界坐标不变。
export function zoomAt(view, screenPoint, factor) {
  const before = screenToWorld(screenPoint, view);
  const scale = clampScale(view.scale * factor);
  return {
    scale,
    pan: {
      x: screenPoint.x - before.x * scale,
      y: screenPoint.y - before.y * scale
    }
  };
}

const WIRE_COLOR = '#63b08a';
const ACCENT = '#ffd166';
const PREVIEW = '#7fd1ff';

function gridLines(ctx, view, width, height) {
  const topLeft = screenToWorld({ x: 0, y: 0 }, view);
  const bottomRight = screenToWorld({ x: width, y: height }, view);
  const minX = Math.min(topLeft.x, bottomRight.x);
  const maxX = Math.max(topLeft.x, bottomRight.x);
  const minY = Math.min(topLeft.y, bottomRight.y);
  const maxY = Math.max(topLeft.y, bottomRight.y);

  if (view.scale >= 2) {
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const subStartX = Math.floor(minX / WIRE_GRID) * WIRE_GRID;
    for (let x = subStartX; x <= maxX; x += WIRE_GRID) {
      const sx = worldToScreen({ x, y: 0 }, view).x;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, height);
    }
    const subStartY = Math.floor(minY / WIRE_GRID) * WIRE_GRID;
    for (let y = subStartY; y <= maxY; y += WIRE_GRID) {
      const sy = worldToScreen({ x: 0, y }, view).y;
      ctx.moveTo(0, sy);
      ctx.lineTo(width, sy);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.11)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  const startX = Math.floor(minX / CELL) * CELL;
  for (let x = startX; x <= maxX; x += CELL) {
    const sx = worldToScreen({ x, y: 0 }, view).x;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, height);
  }
  const startY = Math.floor(minY / CELL) * CELL;
  for (let y = startY; y <= maxY; y += CELL) {
    const sy = worldToScreen({ x: 0, y }, view).y;
    ctx.moveTo(0, sy);
    ctx.lineTo(width, sy);
  }
  ctx.stroke();
}

function strokePolyline(ctx, points, view, color, width, dash, bridges) {
  if (!points || points.length === 0) {
    return;
  }
  ctx.beginPath();
  const first = worldToScreen(points[0], view);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i += 1) {
    const groups = bridges?.get(i - 1);
    if (groups) {
      for (const bridge of groups) traceBridge(ctx, view, bridge);
    }
    const point = worldToScreen(points[i], view);
    ctx.lineTo(point.x, point.y);
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash(dash || []);
  ctx.stroke();
  ctx.setLineDash([]);
}

function openCircle(ctx, world, view) {
  const point = worldToScreen(world, view);
  ctx.beginPath();
  ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#1b1b1b';
  ctx.fill();
  ctx.strokeStyle = '#9a9a9a';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function solidDot(ctx, world, view, color, radius) {
  const point = worldToScreen(world, view);
  ctx.beginPath();
  ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
}


function crossedSegment(points, point) {
  return points.findIndex(function (a, index) {
    const b = points[index + 1];
    return b && (
      (a.y === point.y && b.y === point.y && Math.min(a.x, b.x) < point.x && point.x < Math.max(a.x, b.x)) ||
      (a.x === point.x && b.x === point.x && Math.min(a.y, b.y) < point.y && point.y < Math.max(a.y, b.y))
    );
  });
}

// 只有同一直段上紧邻的越过才合并，桥在折点和 T 接点前回到原线。
export function groupBridgeCrossings(state, crossings) {
  const bySegment = new Map();
  for (const crossing of crossings || []) {
    const { overWireId, point } = crossing;
    const points = state.wires[overWireId]?.points;
    if (!points) continue;
    const segmentIndex = crossedSegment(points, point);
    if (segmentIndex === -1) continue;

    const a = points[segmentIndex];
    const b = points[segmentIndex + 1];
    const direction = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
    const key = overWireId + ':' + segmentIndex;
    let segment = bySegment.get(key);
    if (!segment) {
      segment = { overWireId, segmentIndex, direction, items: [] };
      bySegment.set(key, segment);
    }
    segment.items.push({ point, distance: point.x * direction.x + point.y * direction.y });
  }

  const groups = [];
  for (const { overWireId, segmentIndex, direction, items } of bySegment.values()) {
    items.sort((a, b) => a.distance - b.distance);
    let group;
    let previousDistance;
    for (const item of items) {
      if (!group || item.distance - previousDistance > WIRE_GRID) {
        group = { overWireId, segmentIndex, direction, items: [] };
        groups.push(group);
      }
      group.items.push(item);
      previousDistance = item.distance;
    }
  }
  return groups;
}

// 直接画出上层导线的弧线，保留下层线、相邻导线和网格。
function traceBridge(ctx, view, group) {
  const { direction, items } = group;
  // 路径方向决定绘制顺序，桥顶固定在图纸的左侧或上侧。
  const normal = direction.x === 0 ? { x: -1, y: 0 } : { x: 0, y: -1 };
  const first = items[0].point;
  const last = items[items.length - 1].point;
  function screenPoint(point, along, lift) {
    return worldToScreen({
      x: point.x + direction.x * along + normal.x * lift,
      y: point.y + direction.y * along + normal.y * lift
    }, view);
  }
  const start = screenPoint(first, -BRIDGE_SPAN, 0);
  const end = screenPoint(last, BRIDGE_SPAN, 0);
  ctx.lineTo(start.x, start.y);

  const topStart = screenPoint(first, 0, BRIDGE_LIFT);
  const topEnd = screenPoint(last, 0, BRIDGE_LIFT);
  const rise1 = screenPoint(first, -BRIDGE_SPAN / 2, 0);
  const rise2 = screenPoint(first, -BRIDGE_SPAN / 2, BRIDGE_LIFT);
  const fall1 = screenPoint(last, BRIDGE_SPAN / 2, BRIDGE_LIFT);
  const fall2 = screenPoint(last, BRIDGE_SPAN / 2, 0);
  ctx.bezierCurveTo(rise1.x, rise1.y, rise2.x, rise2.y, topStart.x, topStart.y);
  if (items.length > 1) ctx.lineTo(topEnd.x, topEnd.y);
  ctx.bezierCurveTo(fall1.x, fall1.y, fall2.x, fall2.y, end.x, end.y);
}

function drawEndpoints(ctx, state, view, oscillatingWires, pulse) {
  for (const wireId of Object.keys(state.wires)) {
    const wire = state.wires[wireId];
    const points = wire.points;
    if (!points || points.length === 0) {
      continue;
    }
    const ends = [
      { end: wire.endA, point: points[0] },
      { end: wire.endB, point: points[points.length - 1] }
    ];
    for (const item of ends) {
      if (!item.end) {
        continue;
      }
      if (item.end.kind === 'free') {
        openCircle(ctx, item.point, view);
      } else if (item.end.kind === 'junction') {
        solidDot(ctx, item.point, view,
          oscillatingWires && oscillatingWires.has(wireId) ? pulse.color : WIRE_COLOR, 3);
      }
    }
  }
}

function drawGateSymbol(ctx, type, x, y, size, rotation) {
  const h = size / 2;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(((rotation || 0) * Math.PI) / 2);
  ctx.lineWidth = Math.max(1.5, size * 0.045);
  ctx.strokeStyle = '#d6d6d6';
  ctx.fillStyle = 'rgba(255,255,255,0.05)';
  ctx.lineJoin = 'round';

  if (type === 'DELAY') {
    // Player-facing “delay 门” symbol: τ in a box, matching the component bar.
    ctx.beginPath();
    ctx.rect(-h * 0.36, -h * 0.42, h * 0.72, h * 0.84);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-h * 0.5, 0);
    ctx.lineTo(-h * 0.36, 0);
    ctx.moveTo(h * 0.36, 0);
    ctx.lineTo(h * 0.5, 0);
    ctx.stroke();
    ctx.fillStyle = '#d6d6d6';
    ctx.font = Math.max(8, size * 0.36) + 'px Georgia, "Times New Roman", serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('τ', 0, size * 0.015);
  } else if (type === 'NOT') {
    ctx.beginPath();
    ctx.moveTo(-h * 0.55, -h * 0.5);
    ctx.lineTo(-h * 0.55, h * 0.5);
    ctx.lineTo(h * 0.35, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    if (type === 'NOT') {
      ctx.beginPath();
      ctx.arc(h * 0.47, 0, Math.max(2, h * 0.11), 0, Math.PI * 2);
      ctx.stroke();
    }
  } else if (type === 'AND') {
    ctx.beginPath();
    ctx.moveTo(-h * 0.6, -h * 0.55);
    ctx.lineTo(h * 0.02, -h * 0.55);
    ctx.quadraticCurveTo(h * 0.6, -h * 0.55, h * 0.6, 0);
    ctx.quadraticCurveTo(h * 0.6, h * 0.55, h * 0.02, h * 0.55);
    ctx.lineTo(-h * 0.6, h * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8e8e8';
    ctx.font = 'bold ' + Math.max(7, Math.round(size * 0.24)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('AND', h * 0.18, 0);
  } else if (type === 'OR') {
    ctx.beginPath();
    ctx.moveTo(-h * 0.65, -h * 0.55);
    ctx.quadraticCurveTo(-h * 0.18, 0, -h * 0.65, h * 0.55);
    ctx.quadraticCurveTo(h * 0.12, h * 0.55, h * 0.6, 0);
    ctx.quadraticCurveTo(h * 0.12, -h * 0.55, -h * 0.65, -h * 0.55);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e8e8e8';
    ctx.font = 'bold ' + Math.max(7, Math.round(size * 0.24)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('OR', h * 0.12, 0);
  }

  ctx.restore();
}

// 分组框：透明底、粗灰虚线边、右下角灰底白字标签。
function drawFrame(ctx, frame, view, selected) {
  const rect = frameScreenRect(frame, view);
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  const color = frameColor(frame);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 6]);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();

  const labelRect = frameLabelRect(frame, view);
  ctx.save();
  ctx.fillStyle = color;
  // 描边以边框为中心，标签背景覆盖右侧和底部向外延伸的半条虚线。
  ctx.fillRect(labelRect.x, labelRect.y, labelRect.width + 2, labelRect.height + 2);
  ctx.beginPath();
  ctx.rect(labelRect.x, labelRect.y, labelRect.width, labelRect.height);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.font = FRAME_LABEL_FONT;
  const text = frameLabel(frame);
  const metrics = ctx.measureText(text);
  const position = frameLabelTextLayout(
    labelRect,
    metrics.width,
    Number.isFinite(metrics.actualBoundingBoxAscent) ? metrics.actualBoundingBoxAscent : 9,
    Number.isFinite(metrics.actualBoundingBoxDescent) ? metrics.actualBoundingBoxDescent : 3
  );
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(text, position.x, position.baseline);
  ctx.restore();

  if (selected) {
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(rect.x - 3, rect.y - 3, rect.width + 6, rect.height + 6);
    ctx.restore();
  }
}

function isSelectedFrame(selection, frameId) {
  if (!selection) {
    return false;
  }
  if (selection.kind === 'frame') {
    return selection.id === frameId;
  }
  return selection.kind === 'multi' &&
    Array.isArray(selection.frames) &&
    selection.frames.indexOf(frameId) !== -1;
}

function drawFrames(ctx, state, view, selection) {
  const frames = state.frames || {};
  for (const id of Object.keys(frames)) {
    drawFrame(ctx, frames[id], view, isSelectedFrame(selection, id));
  }
}

function drawFramePreview(ctx, view, frame, color) {
  if (!frame) {
    return;
  }
  const rect = frameScreenRect(frame, view);
  if (rect.width <= 0 || rect.height <= 0) {
    return;
  }
  ctx.save();
  ctx.strokeStyle = color || PREVIEW;
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function componentScreenBounds(component, view, definitionOptions = {}) {
  const bounds = componentBounds(component, definitionOptions.definitions);
  const origin = worldToScreen({ x: bounds.x, y: bounds.y }, view);
  return {
    x: origin.x,
    y: origin.y,
    width: bounds.w * view.scale,
    height: bounds.h * view.scale
  };
}

const iconPathCache = new Map();

function componentIconPaths(iconId) {
  if (typeof Path2D !== 'function') {
    return null;
  }
  if (iconPathCache.has(iconId)) {
    return iconPathCache.get(iconId);
  }
  const icon = getComponentIcon(iconId);
  if (!icon) {
    iconPathCache.set(iconId, null);
    return null;
  }
  const paths = icon.paths.map(function (d) { return new Path2D(d); });
  iconPathCache.set(iconId, paths);
  return paths;
}

// 在元件矩形内居中绘制图标，保持 24×24 宽高比并随元件尺寸缩放。
function drawComponentIcon(ctx, iconId, rect, rotation) {
  const icon = getComponentIcon(iconId);
  const paths = componentIconPaths(iconId);
  if (!icon || !paths || paths.length === 0) {
    return false;
  }
  const pad = Math.max(2, Math.min(rect.width, rect.height) * 0.12);
  const size = Math.min(rect.width - pad * 2, rect.height - pad * 2);
  if (!(size > 2)) {
    return false;
  }
  const scale = size / 24;
  ctx.save();
  ctx.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
  ctx.rotate(((rotation || 0) * Math.PI) / 2);
  ctx.scale(scale, scale);
  ctx.translate(-12, -12);
  ctx.strokeStyle = '#dce8ef';
  ctx.fillStyle = '#dce8ef';
  ctx.lineWidth = Math.max(0.1, 2 / scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const path of paths) {
    ctx.stroke(path);
  }
  if (icon.texts.length > 0) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const text of icon.texts) {
      ctx.font = '700 ' + text.size + 'px system-ui, sans-serif';
      ctx.fillText(text.value, text.x, text.y);
    }
  }
  ctx.restore();
  return true;
}

// 封装名称沿元件长边显示：横长水平居中，竖长旋转 90°；正方形保持水平。
function drawComponentName(ctx, label, rect) {
  const padding = 8;
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;
  const fontSize = Math.max(9, Math.round(Math.min(rect.width, rect.height) * 0.22));
  ctx.save();
  ctx.fillStyle = '#dce8ef';
  ctx.font = 'bold ' + fontSize + 'px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (rect.height > rect.width) {
    ctx.translate(centerX, centerY);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(label, 0, 0, Math.max(1, rect.height - padding));
  } else {
    ctx.fillText(label, centerX, centerY, Math.max(1, rect.width - padding));
  }
  ctx.restore();
}

function drawComponent(ctx, component, view, evaluation, definitionOptions = {}) {
  const rect = componentScreenBounds(component, view, { definitions: definitionOptions.definitions });
  const origin = { x: rect.x, y: rect.y };
  const size = Math.min(rect.width, rect.height);
  const centerX = rect.x + rect.width / 2;
  const centerY = rect.y + rect.height / 2;

  let tint = 'rgba(255,255,255,0.035)';
  if (component.type === 'CONST1') {
    tint = '#24382b';
  } else if (component.type === 'TOGGLE') {
    tint = '#2a3140';
  } else if (component.type === 'BUTTON') {
    tint = component.on ? '#2f4636' : '#26332a';
  } else if (component.type === 'CLOCK') {
    tint = '#2b3345';
  } else if (component.type === 'LAMP') {
    tint = '#322e24';
  } else if (component.type === 'CUSTOM') {
    tint = '#252c33';
  }
  ctx.fillStyle = tint;
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = component.type === 'CUSTOM' ? '#6c8a9c' : '#444';
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

  if (component.type === 'CUSTOM') {
    const definition = componentDefinition(component, definitionOptions.definitions);
    if (definition && definition.icon &&
        drawComponentIcon(ctx, definition.icon, rect, component.rotation || 0)) {
      return;
    }
    const label = definition ? definition.name : component.definitionId || 'CUSTOM';
    drawComponentName(ctx, label, rect);
    return;
  }

  if (component.type === 'CONST1') {
    ctx.fillStyle = '#d9f2df';
    ctx.font = 'bold ' + Math.max(9, Math.round(size * 0.55)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('1', centerX, centerY);
  } else if (component.type === 'TOGGLE') {
    const radius = size * TOGGLE_SWITCH_RADIUS_RATIO;
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fillStyle = component.on ? '#ffd54f' : '#3b3b3b';
    ctx.fill();
    ctx.strokeStyle = '#9a9a9a';
    ctx.lineWidth = Math.max(1, size * 0.035);
    ctx.stroke();
    ctx.fillStyle = component.on ? '#1b1b1b' : '#dddddd';
    ctx.font = 'bold ' + Math.max(8, Math.round(size * 0.32)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(component.on ? '1' : '0', centerX, centerY);
  } else if (component.type === 'BUTTON') {
    const radius = size * TOGGLE_SWITCH_RADIUS_RATIO;
    const on = Boolean(component.on);
    // 按下时内圈变小、下沉并变为绿色，形成与松开的明显对比。
    const innerRadius = radius * (on ? 0.58 : 0.7);
    const innerY = centerY + (on ? radius * 0.08 : 0);
    ctx.beginPath();
    ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
    ctx.fillStyle = '#232323';
    ctx.fill();
    ctx.strokeStyle = on ? '#8fe3a5' : '#8a8a8a';
    ctx.lineWidth = Math.max(1, size * 0.045);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(centerX, innerY, innerRadius, 0, Math.PI * 2);
    ctx.fillStyle = on ? '#59d17c' : '#3b3b3b';
    ctx.fill();
    ctx.strokeStyle = on ? '#2f7a45' : '#666666';
    ctx.lineWidth = Math.max(1, size * 0.03);
    ctx.stroke();
    ctx.fillStyle = on ? '#10361c' : '#dddddd';
    ctx.font = 'bold ' + Math.max(8, Math.round(size * 0.32)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(on ? '1' : '0', centerX, innerY);
  } else if (component.type === 'CLOCK') {
    const on = Boolean(component.on);
    const amplitude = size * 0.2;
    const left = centerX - size * 0.28;
    const right = centerX + size * 0.28;
    const mid = centerY;
    ctx.save();
    ctx.strokeStyle = on ? '#ffd54f' : '#9aa9b8';
    ctx.lineWidth = Math.max(1, size * 0.06);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(left, mid + amplitude);
    ctx.lineTo(left + (right - left) * 0.18, mid + amplitude);
    ctx.lineTo(left + (right - left) * 0.18, mid - amplitude);
    ctx.lineTo(left + (right - left) * 0.5, mid - amplitude);
    ctx.lineTo(left + (right - left) * 0.5, mid + amplitude);
    ctx.lineTo(left + (right - left) * 0.82, mid + amplitude);
    ctx.lineTo(left + (right - left) * 0.82, mid - amplitude);
    ctx.lineTo(right, mid - amplitude);
    ctx.stroke();
    ctx.fillStyle = on ? '#ffd54f' : '#dddddd';
    ctx.font = 'bold ' + Math.max(7, Math.round(size * 0.2)) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CLK', centerX, centerY + size * 0.32);
    ctx.restore();
  } else if (component.type === 'LAMP') {
    const on = Boolean(evaluation && evaluation.lampOn && evaluation.lampOn[component.id]);
    ctx.save();
    if (on) {
      ctx.shadowColor = '#ffe066';
      ctx.shadowBlur = size * 0.7;
    }
    ctx.beginPath();
    ctx.arc(centerX, centerY, size * 0.27, 0, Math.PI * 2);
    ctx.fillStyle = on ? '#ffe066' : '#2b2b2b';
    ctx.fill();
    ctx.restore();
    ctx.beginPath();
    ctx.arc(centerX, centerY, size * 0.27, 0, Math.PI * 2);
    ctx.strokeStyle = on ? '#fff3b0' : '#777';
    ctx.lineWidth = Math.max(1, size * 0.035);
    ctx.stroke();
  } else {
    drawGateSymbol(ctx, component.type, centerX, centerY, size, component.rotation || 0);
  }
}

// 管脚形状：IN 空心圆，OUT 实心方块；形状本身表达方向，不依赖颜色。
function drawPinShape(ctx, world, view, dir, high) {
  const point = worldToScreen(world, view);
  const color = high ? PIN_HIGH_COLOR : '#e2e2e2';
  ctx.save();
  if (dir === 'in') {
    ctx.beginPath();
    ctx.arc(point.x, point.y, PIN_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = high ? color : '#1b1b1b';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = PIN_STROKE_WIDTH;
    ctx.stroke();
  } else {
    const half = PIN_RADIUS;
    ctx.fillStyle = color;
    ctx.fillRect(point.x - half, point.y - half, half * 2, half * 2);
  }
  ctx.restore();
}

// 管脚名按所在封装边的法向显示：左右边横向、上下边竖向，并以管脚点位为中心对齐。
// 返回屏幕锚点、旋转角、绘制对齐方式，以及用于命中测试的轴对齐包围盒。
function pinLabelLayout(component, def, view, definitions, textWidth) {
  const world = pinWorld(component, def.id, definitions);
  const point = worldToScreen(world, view);
  const bounds = componentBounds(component, definitions);
  const side = pinDisplaySide(component, def, world, bounds);
  let x = point.x;
  let y = point.y;
  let angle = 0;
  let align = 'left';
  let rect;
  if (side === 'left') {
    x = point.x - PIN_LABEL_GAP;
    align = 'right';
    rect = {
      x: x - textWidth - PIN_LABEL_PAD,
      y: y - PIN_LABEL_HEIGHT / 2 - PIN_LABEL_PAD,
      width: textWidth + PIN_LABEL_PAD * 2,
      height: PIN_LABEL_HEIGHT + PIN_LABEL_PAD * 2
    };
  } else if (side === 'right') {
    x = point.x + PIN_LABEL_GAP;
    align = 'left';
    rect = {
      x: x - PIN_LABEL_PAD,
      y: y - PIN_LABEL_HEIGHT / 2 - PIN_LABEL_PAD,
      width: textWidth + PIN_LABEL_PAD * 2,
      height: PIN_LABEL_HEIGHT + PIN_LABEL_PAD * 2
    };
  } else if (side === 'top') {
    // 向上伸出：旋转 -90°，文字沿旋转后的 +x 方向从锚点向上延伸。
    y = point.y - PIN_LABEL_GAP;
    angle = -Math.PI / 2;
    align = 'left';
    rect = {
      x: x - PIN_LABEL_HEIGHT / 2 - PIN_LABEL_PAD,
      y: y - textWidth - PIN_LABEL_PAD,
      width: PIN_LABEL_HEIGHT + PIN_LABEL_PAD * 2,
      height: textWidth + PIN_LABEL_PAD * 2
    };
  } else {
    // 向下伸出：仍旋转 -90° 保持文字方向一致，改用右对齐从锚点向下延伸。
    y = point.y + PIN_LABEL_GAP;
    angle = -Math.PI / 2;
    align = 'right';
    rect = {
      x: x - PIN_LABEL_HEIGHT / 2 - PIN_LABEL_PAD,
      y: y - PIN_LABEL_PAD,
      width: PIN_LABEL_HEIGHT + PIN_LABEL_PAD * 2,
      height: textWidth + PIN_LABEL_PAD * 2
    };
  }
  return {
    x,
    y,
    angle,
    align,
    baseline: 'middle',
    side,
    rect
  };
}

// 取管脚实际显示边；有 side 时按元件旋转同步，缺失时按离矩形边最近的一侧推断。
function pinDisplaySide(component, def, world, bounds) {
  const rotation = ((component.rotation || 0) % 4 + 4) % 4;
  const baseIndex = PIN_SIDE_ORDER.indexOf(def.side);
  if (baseIndex >= 0) {
    return PIN_SIDE_ORDER[(baseIndex + rotation) % 4];
  }
  if (bounds) {
    const distances = [
      { side: 'top', value: Math.abs(world.y - bounds.y) },
      { side: 'right', value: Math.abs(bounds.x + bounds.w - world.x) },
      { side: 'bottom', value: Math.abs(bounds.y + bounds.h - world.y) },
      { side: 'left', value: Math.abs(world.x - bounds.x) }
    ];
    distances.sort(function (a, b) { return a.value - b.value; });
    return distances[0].side;
  }
  return 'right';
}

function drawPinLabel(ctx, entry) {
  const layout = entry.layout;
  ctx.save();
  ctx.fillStyle = '#b9cbd5';
  ctx.font = PIN_LABEL_FONT;
  ctx.translate(layout.x, layout.y);
  ctx.rotate(layout.angle);
  ctx.textAlign = layout.align;
  ctx.textBaseline = layout.baseline;
  ctx.fillText(entry.text, 0, 0);
  ctx.restore();
}

// 缩放后相邻管脚名可能互相覆盖；一旦可见标签发生重叠就整体隐藏，只在悬停该管脚时显示。
function pinLabelsOverlap(entries, width, height) {
  if (entries.length < 2) {
    return false;
  }
  const hasViewport = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0;
  const visible = hasViewport
    ? entries.filter(function (entry) {
      const rect = entry.layout.rect;
      return rect.x + rect.width > 0 && rect.x < width && rect.y + rect.height > 0 && rect.y < height;
    })
    : entries;
  if (visible.length < 2) {
    return false;
  }
  const sorted = visible.slice().sort(function (a, b) {
    return a.layout.rect.x - b.layout.rect.x;
  });
  for (let i = 0; i < sorted.length; i += 1) {
    const a = sorted[i].layout.rect;
    const aRight = a.x + a.width;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const b = sorted[j].layout.rect;
      if (b.x >= aRight) break;
      if (a.y < b.y + b.height && a.y + a.height > b.y) {
        return true;
      }
    }
  }
  return false;
}

function drawPins(ctx, state, view, definitions, hoverPin, width, height, previewValues) {
  const labels = [];
  ctx.save();
  ctx.font = PIN_LABEL_FONT;
  for (const componentId of Object.keys(state.components)) {
    const component = state.components[componentId];
    const defs = componentPins(component, definitions) || [];
    for (const def of defs) {
      const world = pinWorld(component, def.id, definitions);
      const high = previewValues?.[def.id] === 1;
      drawPinShape(ctx, world, view, def.dir, high);
      if (component.type !== 'CUSTOM' || !def.label) {
        continue;
      }
      const textWidth = ctx.measureText(def.label).width;
      const layout = pinLabelLayout(component, def, view, definitions, textWidth);
      if (previewValues) {
        drawPreviewPinValue(ctx, worldToScreen(world, view), layout.side, previewValues[def.id]);
      }
      labels.push({
        componentId,
        pinId: def.id,
        text: def.label,
        layout
      });
    }
  }
  ctx.restore();
  const hideAll = pinLabelsOverlap(labels, width, height);
  for (const entry of labels) {
    const hovered = Boolean(hoverPin &&
      hoverPin.componentId === entry.componentId &&
      hoverPin.pinId === entry.pinId);
    if (hideAll && !hovered) {
      continue;
    }
    drawPinLabel(ctx, entry);
  }
}

function drawPreviewPinValue(ctx, point, side, bit) {
  const inward = PIN_VALUE_INWARD[side];
  const inset = PIN_LABEL_GAP + PIN_LABEL_HEIGHT / 2;
  const x = point.x + inward.x * inset;
  const y = point.y + inward.y * inset;
  const value = bit === null ? '—' : bit === 1 ? '1' : '0';
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#252c33';
  ctx.strokeText(value, x, y);
  ctx.fillStyle = bit === 1 ? PIN_HIGH_COLOR : '#e2e2e2';
  ctx.fillText(value, x, y);
  ctx.restore();
}

function drawPinHover(ctx, view, pin) {
  if (!pin || !pin.point) {
    return;
  }
  const point = worldToScreen(pin.point, view);
  ctx.save();
  ctx.beginPath();
  ctx.arc(point.x, point.y, 9, 0, Math.PI * 2);
  ctx.strokeStyle = PREVIEW;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

function roundedRectPath(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function portAnnotationLayout(annotation, view, ctx) {
  const point = worldToScreen(annotation.point, view);
  let dx = 0;
  let dy = -1;
  if (annotation.center) {
    const center = worldToScreen(annotation.center, view);
    const vx = point.x - center.x;
    const vy = point.y - center.y;
    const length = Math.hypot(vx, vy);
    if (length > 0.5) {
      dx = vx / length;
      dy = vy / length;
    }
  }
  const text = (annotation.direction === 'in' ? 'IN ' : 'OUT ') + annotation.name;
  ctx.save();
  ctx.font = 'bold 11px system-ui, sans-serif';
  const textWidth = ctx.measureText(text).width;
  ctx.restore();
  const badgeWidth = textWidth + 12;
  const badgeHeight = 18;
  const halfExtentAlongDirection =
    Math.abs(dx) * badgeWidth / 2 + Math.abs(dy) * badgeHeight / 2;
  const badgeCenterX = point.x + dx * (7 + 8 + halfExtentAlongDirection);
  const badgeCenterY = point.y + dy * (7 + 8 + halfExtentAlongDirection);
  return {
    point,
    dx,
    dy,
    text,
    color: annotation.direction === 'in' ? '#7fd1ff' : '#ffd166',
    ringRadius: 7,
    badgeWidth,
    badgeHeight,
    badgeCenterX,
    badgeCenterY,
    badgeX: badgeCenterX - badgeWidth / 2,
    badgeY: badgeCenterY - badgeHeight / 2,
    halfExtentAlongDirection
  };
}

export function hitPortAnnotation(annotations, view, screen, ctx) {
  if (!annotations || annotations.length === 0) {
    return null;
  }
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (!annotation) continue;
    const layout = portAnnotationLayout(annotation, view, ctx);
    if (screen.x >= layout.badgeX - 2 &&
        screen.x <= layout.badgeX + layout.badgeWidth + 2 &&
        screen.y >= layout.badgeY - 2 &&
        screen.y <= layout.badgeY + layout.badgeHeight + 2) {
      return annotation;
    }
    const dist = Math.hypot(screen.x - layout.point.x, screen.y - layout.point.y);
    if (dist <= layout.ringRadius + 3) {
      return annotation;
    }
  }
  return null;
}

export function hitPortAnnotationLabel(annotations, view, screen, ctx) {
  if (!annotations || annotations.length === 0) {
    return null;
  }
  for (let index = annotations.length - 1; index >= 0; index -= 1) {
    const annotation = annotations[index];
    if (!annotation) continue;
    const layout = portAnnotationLayout(annotation, view, ctx);
    if (screen.x >= layout.badgeX - 2 &&
        screen.x <= layout.badgeX + layout.badgeWidth + 2 &&
        screen.y >= layout.badgeY - 2 &&
        screen.y <= layout.badgeY + layout.badgeHeight + 2) {
      return annotation;
    }
  }
  return null;
}

function drawPortAnnotations(ctx, view, annotations, selectedPortId) {
  if (!annotations || annotations.length === 0) {
    return;
  }
  ctx.save();
  ctx.font = 'bold 11px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  for (const annotation of annotations) {
    const layout = portAnnotationLayout(annotation, view, ctx);
    const selected = Boolean(selectedPortId && annotation.id === selectedPortId);
    ctx.save();
    if (selected) {
      ctx.shadowColor = ACCENT;
      ctx.shadowBlur = 10;
    }
    ctx.beginPath();
    ctx.arc(layout.point.x, layout.point.y, layout.ringRadius, 0, Math.PI * 2);
    ctx.strokeStyle = layout.color;
    ctx.lineWidth = selected ? 3.5 : 2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(layout.point.x, layout.point.y, 2, 0, Math.PI * 2);
    ctx.fillStyle = layout.color;
    ctx.fill();

    ctx.strokeStyle = layout.color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.point.x + layout.dx * layout.ringRadius,
      layout.point.y + layout.dy * layout.ringRadius);
    ctx.lineTo(layout.badgeCenterX - layout.dx * (layout.halfExtentAlongDirection + 1),
      layout.badgeCenterY - layout.dy * (layout.halfExtentAlongDirection + 1));
    ctx.stroke();
    roundedRectPath(ctx, layout.badgeX, layout.badgeY,
      layout.badgeWidth, layout.badgeHeight, 4);
    ctx.fillStyle = selected ? 'rgba(80,66,30,0.96)' : 'rgba(18,24,28,0.92)';
    ctx.fill();
    ctx.strokeStyle = selected ? ACCENT : layout.color;
    ctx.lineWidth = selected ? 2 : 1;
    ctx.stroke();
    ctx.fillStyle = layout.color;
    ctx.textAlign = 'center';
    ctx.fillText(layout.text, layout.badgeCenterX, layout.badgeCenterY + 0.5);
    ctx.restore();
  }
  ctx.restore();
}

function drawWireSelection(ctx, state, view, selection, oscillatingWires, wireBridges) {
  if (!selection) {
    return;
  }
  let ids = [];
  if (selection.kind === 'wire' && selection.id) {
    ids = [selection.id];
  } else if (selection.kind === 'multi' && Array.isArray(selection.wires)) {
    ids = selection.wires;
  }
  for (const id of ids) {
    const wire = state.wires[id];
    if (wire) {
      strokePolyline(ctx, wire.points, view, ACCENT,
        oscillatingWires.has(id) ? 6.5 : 4.5, null, wireBridges.get(id));
    }
  }
}

function drawOscillatingComponents(ctx, state, view, highlight, pulse, definitions) {
  if (!highlight) return;
  ctx.save();
  ctx.strokeStyle = pulse.color;
  ctx.lineWidth = pulse.width;
  for (const id of highlight.componentIds) {
    const component = state.components[id];
    if (!component) continue;
    const rect = componentScreenBounds(component, view, { definitions });
    // Outside the existing body/selection border: names and symbols stay clear.
    ctx.strokeRect(rect.x - 4, rect.y - 4, rect.width + 8, rect.height + 8);
  }
  ctx.restore();
}

function drawComponentSelection(ctx, state, view, selection, definitionOptions = {}) {
  if (!selection) {
    return;
  }
  let ids = [];
  if (selection.kind === 'component' && selection.id) {
    ids = [selection.id];
  } else if (selection.kind === 'multi' && Array.isArray(selection.components)) {
    ids = selection.components;
  }
  for (const id of ids) {
    const component = state.components[id];
    if (!component) {
      continue;
    }
    const rect = componentScreenBounds(component, view, { definitions: definitionOptions.definitions });
    ctx.save();
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 3;
    ctx.shadowColor = ACCENT;
    ctx.shadowBlur = 8;
    ctx.strokeRect(rect.x - 1, rect.y - 1, rect.width + 2, rect.height + 2);
    ctx.restore();
  }
}

function drawGhost(ctx, view, ghost, definitionOptions = {}) {
  if (!ghost) {
    return;
  }
  const rect = componentScreenBounds(ghost, view, { definitions: definitionOptions.definitions });
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.strokeStyle = PREVIEW;
  ctx.lineWidth = 1.5;
  ctx.fillStyle = 'rgba(127,209,255,0.08)';
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
  ctx.restore();
}

function drawHover(ctx, view, anchor) {
  if (!anchor) {
    return;
  }
  const point = worldToScreen(anchor, view);
  ctx.beginPath();
  ctx.arc(point.x, point.y, 6, 0, Math.PI * 2);
  ctx.strokeStyle = PREVIEW;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(point.x, point.y, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = PREVIEW;
  ctx.fill();
}

function drawWireStart(ctx, view, point) {
  if (!point) {
    return;
  }
  const screen = worldToScreen(point, view);
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, 8, 0, Math.PI * 2);
  ctx.strokeStyle = PREVIEW;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = PREVIEW;
  ctx.fill();
}

function drawRubber(ctx, view, rubber) {
  if (!rubber || !rubber.points || rubber.points.length < 2) {
    return;
  }
  let color = '#8a8a8a';
  if (rubber.status === 'valid') {
    color = WIRE_COLOR;
  } else if (rubber.status === 'invalid') {
    color = '#ff6b6b';
  }
  strokePolyline(ctx, rubber.points, view, color, 2, [8, 6]);
}

// 拖动预览：整根候选折线用虚线画出；非法红色，自由悬空灰色。
function drawWireDrag(ctx, view, drag) {
  if (!drag || !drag.points || drag.points.length < 2) {
    return;
  }
  let color = PREVIEW;
  if (drag.status === 'invalid') {
    color = '#ff6b6b';
  } else if (drag.status === 'free') {
    color = '#8a8a8a';
  }
  strokePolyline(ctx, drag.points, view, color, 2, [8, 6]);
  for (const branch of drag.branches || []) {
    strokePolyline(ctx, branch.points, view, color, 2, [8, 6]);
  }
}

function drawPreview(ctx, view, preview) {
  if (!preview || !preview.points || preview.points.length === 0) {
    return;
  }
  if (preview.points.length === 1) {
    solidDot(ctx, preview.points[0], view, PREVIEW, 3);
    return;
  }
  strokePolyline(ctx, preview.points, view, PREVIEW, 2, [8, 6]);
  solidDot(ctx, preview.points[0], view, PREVIEW, 3);
  solidDot(ctx, preview.points[preview.points.length - 1], view, PREVIEW, 3);
}

// 框选矩形（屏幕坐标）：半透明填充 + 虚线边。
function drawMarquee(ctx, marquee) {
  if (!marquee) {
    return;
  }
  const x = Math.min(marquee.x1, marquee.x2);
  const y = Math.min(marquee.y1, marquee.y2);
  const width = Math.abs(marquee.x2 - marquee.x1);
  const height = Math.abs(marquee.y2 - marquee.y1);
  const deleting = marquee.status === 'delete';
  const copying = marquee.status === 'copy';
  ctx.save();
  ctx.fillStyle = deleting
    ? 'rgba(255, 107, 107, 0.08)'
    : copying
      ? 'rgba(255, 209, 102, 0.10)'
      : 'rgba(127, 209, 255, 0.08)';
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = deleting ? '#ff6b6b' : copying ? ACCENT : PREVIEW;
  ctx.lineWidth = 1;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(x, y, width, height);
  ctx.restore();
}

// 多选整体拖动预览：目标位置的元件 ghost + 平移后的选中导线虚线。
function drawGroupDrag(ctx, view, groupDrag, definitionOptions = {}) {
  if (!groupDrag) {
    return;
  }
  for (const ghost of groupDrag.components || []) {
    drawGhost(ctx, view, ghost, { definitions: definitionOptions.definitions });
  }
  for (const wire of groupDrag.wires || []) {
    strokePolyline(ctx, wire.points, view, PREVIEW, 2, [5, 4]);
  }
  for (const frame of groupDrag.frames || []) {
    drawFramePreview(ctx, view, frame);
  }
}

// 复制预览：目标位置的元件 ghost（合法蓝色、非法红色）。
function drawCopyGhost(ctx, view, ghost, definitionOptions = {}) {
  if (!ghost) {
    return;
  }
  const color = ghost.status === 'invalid' ? '#ff6b6b' : PREVIEW;
  const fill = ghost.status === 'invalid'
    ? 'rgba(255, 107, 107, 0.08)'
    : 'rgba(127, 209, 255, 0.08)';
  for (const component of ghost.components || []) {
    const rect = componentScreenBounds(component, view, { definitions: definitionOptions.definitions });
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.fillStyle = fill;
    ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.restore();
  }
  for (const points of ghost.wires || []) {
    strokePolyline(ctx, points, view, color, 2, [5, 4]);
  }
  for (const frame of ghost.frames || []) {
    drawFramePreview(ctx, view, frame, color);
  }
}


function definitionPreviewGeometry(width, height, definition, zoom) {
  if (!definition || !definition.size) {
    return null;
  }
  const definitions = { definitions: { __preview__: definition } };
  const component = {
    id: '__preview__',
    type: 'CUSTOM',
    cx: 0,
    cy: 0,
    rotation: 0,
    definitionId: '__preview__'
  };
  const bounds = componentBounds(component, definitions);
  const padding = 28;
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const zoomFactor = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const fitScale = Math.min(
    availableWidth / Math.max(1, bounds.w),
    availableHeight / Math.max(1, bounds.h)
  );
  const scale = Math.min(MAX_SCALE, fitScale * zoomFactor);
  const view = {
    scale,
    pan: {
      x: width / 2 - (bounds.x + bounds.w / 2) * scale,
      y: height / 2 - (bounds.y + bounds.h / 2) * scale
    }
  };
  return {
    definitions,
    component,
    bounds,
    view,
    fitScale,
    rect: {
      x: bounds.x * scale + view.pan.x,
      y: bounds.y * scale + view.pan.y,
      width: bounds.w * scale,
      height: bounds.h * scale
    }
  };
}

export function previewZoomBounds(width, height, definition) {
  const geometry = definitionPreviewGeometry(width, height, definition, 1);
  if (!geometry || !Number.isFinite(geometry.fitScale) || geometry.fitScale <= 0) {
    return { min: 0.1, max: 1 };
  }
  return {
    min: 0.1,
    max: Math.max(0.1, MAX_SCALE / geometry.fitScale)
  };
}

export function previewPortSlots(width, height, definition, zoom) {
  const geometry = definitionPreviewGeometry(width, height, definition, zoom);
  if (!geometry) {
    return [];
  }
  const rows = definition.size.rows;
  const cols = definition.size.cols;
  const ports = Array.isArray(definition.ports) ? definition.ports : [];
  const slots = [];
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const count = slotCount(rows, cols, side);
    for (let slot = 0; slot < count; slot += 1) {
      const offset = slotOffset(rows, cols, side, slot);
      if (!offset) continue;
      const point = worldToScreen(offset, geometry.view);
      const port = ports.find(function (item) {
        return item.side === side && item.slot === slot;
      });
      slots.push({
        side,
        slot,
        point,
        portId: port ? port.id : null
      });
    }
  }
  return slots;
}

export function previewPortLabelRects(width, height, definition, ctx, zoom) {
  const geometry = definitionPreviewGeometry(width, height, definition, zoom);
  if (!geometry) {
    return [];
  }
  const pins = componentPins(geometry.component, geometry.definitions) || [];
  const labels = [];
  ctx.save();
  ctx.font = PIN_LABEL_FONT;
  for (const pin of pins) {
    if (!pin.label) continue;
    const textWidth = ctx.measureText(pin.label).width;
    const layout = pinLabelLayout(geometry.component, pin, geometry.view, geometry.definitions, textWidth);
    labels.push({
      portId: pin.id,
      text: pin.label,
      rect: layout.rect
    });
  }
  ctx.restore();
  return labels;
}

// 详情面板中的封装外观预览：外层矩形 + R×C 单元格 + 名称 + 管脚。
// 详情面板中的封装外观预览：外层矩形 + R×C 单元格 + 名称 + 管脚。
export function drawDefinitionPreview(ctx, width, height, definition, selectedPortId, dropState, showSlots, zoom, hoveredPortId, portValues) {
  ctx.clearRect(0, 0, width, height);
  const geometry = definitionPreviewGeometry(width, height, definition, zoom);
  if (!geometry) {
    return;
  }
  const definitions = geometry.definitions;
  const component = geometry.component;
  const view = geometry.view;
  const rect = geometry.rect;
  const scale = view.scale;
  ctx.save();
  ctx.fillStyle = '#252c33';
  ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
  ctx.strokeStyle = '#6c8a9c';
  ctx.lineWidth = 1;
  ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);

  const rows = definition.size.rows;
  const cols = definition.size.cols;
  const stepX = CELL * scale;
  const stepY = CELL * scale;
  if (stepX >= 4 || stepY >= 4) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.beginPath();
    if (stepX >= 4) {
      for (let col = 1; col < cols; col += 1) {
        const x = rect.x + col * stepX;
        ctx.moveTo(x, rect.y);
        ctx.lineTo(x, rect.y + rect.height);
      }
    }
    if (stepY >= 4) {
      for (let row = 1; row < rows; row += 1) {
        const y = rect.y + row * stepY;
        ctx.moveTo(rect.x, y);
        ctx.lineTo(rect.x + rect.width, y);
      }
    }
    ctx.stroke();
  }

  const label = definition.name || definition.id || 'CUSTOM';
  if (!definition.icon || !drawComponentIcon(ctx, definition.icon, rect, 0)) {
    drawComponentName(ctx, label, rect);
  }

  drawPins(ctx, { components: { __preview__: component } }, view, definitions,
    hoveredPortId ? { componentId: '__preview__', pinId: hoveredPortId } : null,
    width, height, portValues);
  if (showSlots || (dropState && dropState.active)) {
    const slots = previewPortSlots(width, height, definition, zoom);
    const active = Boolean(dropState && dropState.active);
    ctx.save();
    for (const slot of slots) {
      if (slot.portId) continue;
      ctx.beginPath();
      ctx.arc(slot.point.x, slot.point.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = active
        ? 'rgba(185,211,226,0.85)'
        : 'rgba(185,211,226,0.45)';
      ctx.fill();
    }
    const target = dropState && dropState.target;
    if (target && target.side && Number.isInteger(target.slot)) {
      const slot = slots.find(function (item) {
        return item.side === target.side && item.slot === target.slot;
      });
      if (slot) {
        const color = target.valid ? ACCENT : '#ff6b6b';
        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2.5;
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(slot.point.x, slot.point.y, 7, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.restore();
  }
  if (selectedPortId) {
    const pins = componentPins(component, definitions) || [];
    const selectedPin = pins.find(function (pin) { return pin.id === selectedPortId; });
    if (selectedPin) {
      const point = worldToScreen(pinWorld(component, selectedPin.id, definitions), view);
      ctx.save();
      ctx.strokeStyle = ACCENT;
      ctx.lineWidth = 3;
      ctx.shadowColor = ACCENT;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.restore();
}

export function render(ctx, width, height, state, view, ui, evaluation) {
  const overlay = ui || {};
  const highlight = getOscillationHighlight(state, evaluation, overlay.definitions);
  const oscillatingWires = new Set(highlight ? highlight.wireIds : []);
  const pulse = oscillationPulse(overlay.oscillationTimeMs, overlay.reducedMotion);
  ctx.save();
  ctx.fillStyle = '#1b1b1b';
  ctx.fillRect(0, 0, width, height);

  gridLines(ctx, view, width, height);
  drawFrames(ctx, state, view, overlay.selection);

  const wireBridges = new Map();
  for (const bridge of groupBridgeCrossings(state, findCrossings(state))) {
    if (!wireBridges.has(bridge.overWireId)) wireBridges.set(bridge.overWireId, new Map());
    const segments = wireBridges.get(bridge.overWireId);
    if (!segments.has(bridge.segmentIndex)) segments.set(bridge.segmentIndex, []);
    segments.get(bridge.segmentIndex).push(bridge);
  }
  for (const wireId of Object.keys(state.wires)) {
    const wire = state.wires[wireId];
    strokePolyline(ctx, wire.points, view, WIRE_COLOR, 2, null, wireBridges.get(wireId));
  }
  drawWireSelection(ctx, state, view, overlay.selection, oscillatingWires, wireBridges);
  for (const wireId of oscillatingWires) {
    strokePolyline(ctx, state.wires[wireId].points, view, pulse.color, pulse.width,
      null, wireBridges.get(wireId));
  }
  drawEndpoints(ctx, state, view, oscillatingWires, pulse);

  for (const componentId of Object.keys(state.components)) {
    drawComponent(ctx, state.components[componentId], view, evaluation, { definitions: (ui || {}).definitions });
  }
  if (view.scale >= PIN_MIN_SCALE) {
    drawPins(ctx, state, view, (ui || {}).definitions, overlay.hoverPin, width, height);
    drawPinHover(ctx, view, overlay.hoverPin);
  }
  drawPortAnnotations(ctx, view, overlay.portAnnotations, overlay.selectedPortId);

  drawGhost(ctx, view, overlay.dragGhost, { definitions: (ui || {}).definitions });
  drawComponentSelection(ctx, state, view, overlay.selection, { definitions: (ui || {}).definitions });
  drawOscillatingComponents(ctx, state, view, highlight, pulse, overlay.definitions);
  drawWireDrag(ctx, view, overlay.wireDrag || overlay.endpointDrag);
  drawGroupDrag(ctx, view, overlay.groupDrag, { definitions: (ui || {}).definitions });
  drawCopyGhost(ctx, view, overlay.copyGhost, { definitions: (ui || {}).definitions });
  drawPreview(ctx, view, overlay.preview);
  drawWireStart(ctx, view, overlay.wireStart);
  drawRubber(ctx, view, overlay.rubber);
  drawHover(ctx, view, overlay.hoverAnchor);
  drawMarquee(ctx, overlay.marquee);
  drawFramePreview(ctx, view, overlay.frameDraw || overlay.frameDrag);

  ctx.restore();
}
