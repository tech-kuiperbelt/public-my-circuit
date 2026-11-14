import { getDefinition } from './definition-source.js';
// 几何契约：格坐标、引脚偏移、顺时针旋转与引脚世界坐标。
export const CELL = 20;
// 一个元件格切成 5×5 个 4 单位布线子格。
export const WIRE_GRID = CELL / 5;

export function snapToWireGrid(value) {
  return Math.round(value / WIRE_GRID) * WIRE_GRID;
}

export function isWireGridPoint(point) {
  return Boolean(point) &&
    Number.isInteger(point.x) &&
    Number.isInteger(point.y) &&
    point.x % WIRE_GRID === 0 &&
    point.y % WIRE_GRID === 0;
}

const definitionPinCache = new WeakMap();

export function componentDefinition(component, definitions) {
  if (!component || component.type !== 'CUSTOM') {
    return null;
  }
  return getDefinition(definitions, component.definitionId);
}

export function componentSize(component, definitions) {
  const definition = componentDefinition(component, definitions);
  const rows = definition && definition.size && Number.isInteger(definition.size.rows) && definition.size.rows > 0
    ? definition.size.rows
    : 1;
  const cols = definition && definition.size && Number.isInteger(definition.size.cols) && definition.size.cols > 0
    ? definition.size.cols
    : 1;
  return { rows, cols };
}

export function slotCount(rows, cols, side) {
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1) {
    return 0;
  }
  if (side === 'top' || side === 'bottom') return cols * 5 - 1;
  if (side === 'left' || side === 'right') return rows * 5 - 1;
  return 0;
}

// 旧槽位保持每格 4/8/12/16 的坐标；交界点槽位追加在旧编号之后，避免移动已有管脚。
export function slotOffset(rows, cols, side, slot) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= slotCount(rows, cols, side)) {
    return null;
  }
  const cells = side === 'top' || side === 'bottom' ? cols : rows;
  const tangent = slot < cells * 4
    ? CELL * Math.floor(slot / 4) + WIRE_GRID * ((slot % 4) + 1)
    : CELL * (slot - cells * 4 + 1);
  if (side === 'top') return { x: tangent, y: 0 };
  if (side === 'bottom') return { x: tangent, y: rows * CELL };
  if (side === 'left') return { x: 0, y: tangent };
  if (side === 'right') return { x: cols * CELL, y: tangent };
  return null;
}

export function rotatePointInRect(point, width, height, steps) {
  const n = ((steps % 4) + 4) % 4;
  let x = point.x;
  let y = point.y;
  for (let i = 0; i < n; i += 1) {
    const nx = height - y;
    const ny = x;
    x = nx;
    y = ny;
    const swap = width;
    width = height;
    height = swap;
  }
  return { x, y };
}

// 定义驱动管脚：Meta 使用静态表；CUSTOM 从 definition.ports 派生。
// 本接口只描述逻辑方向与稳定 ID，外部槽位布局由后续 UI 步骤补充。
export function componentPins(component, definitions) {
  if (!component || component.type !== 'CUSTOM') {
    return COMPONENT_PINS[component && component.type] || null;
  }
  const definition = getDefinition(definitions, component.definitionId);
  if (!definition || !Array.isArray(definition.ports)) {
    return null;
  }
  let pins = definitionPinCache.get(definition);
  const stale = pins && (pins.length !== definition.ports.length ||
    pins.some(function (pin, index) {
      const port = definition.ports[index];
      return pin.id !== port.id ||
        pin.dir !== (port.direction === 'in' ? 'in' : 'out') ||
        pin.side !== (port.side || null) ||
        pin.slot !== (Number.isInteger(port.slot) ? port.slot : null);
    }));
  if (!pins || stale) {
    pins = Object.freeze(definition.ports.map(function (port) {
      return Object.freeze({
        id: port.id,
        label: port.name || port.id,
        dir: port.direction === 'in' ? 'in' : 'out',
        side: port.side || null,
        slot: Number.isInteger(port.slot) ? port.slot : null,
        offset: port.offset || null
      });
    }));
    definitionPinCache.set(definition, pins);
  }
  return pins;
}

export const COMPONENT_PINS = Object.freeze({
  CONST1: Object.freeze([
    Object.freeze({ id: 'out', label: 'OUT', dir: 'out', offset: Object.freeze({ x: 20, y: 12 }) })
  ]),
  TOGGLE: Object.freeze([
    Object.freeze({ id: 'out', label: 'OUT', dir: 'out', offset: Object.freeze({ x: 20, y: 12 }) })
  ]),
  BUTTON: Object.freeze([
    Object.freeze({ id: 'out', label: 'OUT', dir: 'out', offset: Object.freeze({ x: 20, y: 12 }) })
  ]),
  CLOCK: Object.freeze([
    Object.freeze({ id: 'out', label: 'OUT', dir: 'out', offset: Object.freeze({ x: 20, y: 12 }) })
  ]),
  NOT: Object.freeze([
    Object.freeze({ id: 'in', label: 'A', dir: 'in', offset: Object.freeze({ x: 0, y: 12 }) }),
    Object.freeze({ id: 'out', label: 'Y', dir: 'out', offset: Object.freeze({ x: 20, y: 12 }) })
  ]),
  DELAY: Object.freeze([
    Object.freeze({ id: 'in', label: 'IN', dir: 'in', offset: Object.freeze({ x: 0, y: 12 }) }),
    Object.freeze({ id: 'out', label: 'OUT', dir: 'out', offset: Object.freeze({ x: 20, y: 12 }) })
  ]),
  AND: Object.freeze([
    Object.freeze({ id: 'a', label: 'A', dir: 'in', offset: Object.freeze({ x: 0, y: 4 }) }),
    Object.freeze({ id: 'b', label: 'B', dir: 'in', offset: Object.freeze({ x: 0, y: 16 }) }),
    Object.freeze({ id: 'out', label: 'Y', dir: 'out', offset: Object.freeze({ x: 20, y: 12 }) })
  ]),
  OR: Object.freeze([
    Object.freeze({ id: 'a', label: 'A', dir: 'in', offset: Object.freeze({ x: 0, y: 4 }) }),
    Object.freeze({ id: 'b', label: 'B', dir: 'in', offset: Object.freeze({ x: 0, y: 16 }) }),
    Object.freeze({ id: 'out', label: 'Y', dir: 'out', offset: Object.freeze({ x: 20, y: 12 }) })
  ]),
  LAMP: Object.freeze([
    Object.freeze({ id: 'in', label: 'IN', dir: 'in', offset: Object.freeze({ x: 0, y: 12 }) })
  ])
});

// 格坐标 -> 该格左上角的世界坐标。
export function cellToWorld(cx, cy) {
  return { x: cx * CELL, y: cy * CELL };
}

// 顺时针旋转 steps 次（steps 取 0..3，按 mod 4 归一），纯整数。
export function rotateOffset(offset, steps) {
  const n = ((steps % 4) + 4) % 4;
  let x = offset.x;
  let y = offset.y;
  for (let i = 0; i < n; i += 1) {
    const nx = CELL - y;
    const ny = x;
    x = nx;
    y = ny;
  }
  return { x, y };
}

// 实例的轴对齐世界矩形。CUSTOM 使用定义 R×C；奇数次旋转交换宽高。
export function componentBounds(component, definitions) {
  if (!component) return null;
  const x = component.cx * CELL;
  const y = component.cy * CELL;
  if (component.type !== 'CUSTOM') {
    return { x, y, w: CELL, h: CELL };
  }
  const size = componentSize(component, definitions);
  const rotation = ((component.rotation || 0) % 4 + 4) % 4;
  const odd = rotation % 2 === 1;
  return {
    x,
    y,
    w: (odd ? size.rows : size.cols) * CELL,
    h: (odd ? size.cols : size.rows) * CELL
  };
}

export function pointInBounds(point, bounds, inclusive) {
  if (!point || !bounds) return false;
  if (inclusive) {
    return point.x >= bounds.x && point.x <= bounds.x + bounds.w &&
      point.y >= bounds.y && point.y <= bounds.y + bounds.h;
  }
  return point.x > bounds.x && point.x < bounds.x + bounds.w &&
    point.y > bounds.y && point.y < bounds.y + bounds.h;
}

export function boundsOverlap(a, b) {
  return Boolean(a && b) &&
    a.x < b.x + b.w && a.x + a.w > b.x &&
    a.y < b.y + b.h && a.y + a.h > b.y;
}

// 实例 { type, cx, cy, rotation } 的指定引脚世界坐标。
// CUSTOM 需要传入 definitions 才能解析动态管脚；Meta 调用保持原签名兼容。
export function pinWorld(instance, pinId, definitions) {
  const pins = componentPins(instance, definitions);
  if (!pins) {
    throw new Error('unknown component type: ' + instance.type);
  }
  const pin = pins.find((p) => p.id === pinId);
  if (!pin) {
    throw new Error('unknown pin: ' + instance.type + '.' + pinId);
  }
  const origin = cellToWorld(instance.cx, instance.cy);
  if (instance.type !== 'CUSTOM') {
    const offset = rotateOffset(pin.offset, instance.rotation || 0);
    return { x: origin.x + offset.x, y: origin.y + offset.y };
  }
  const size = componentSize(instance, definitions);
  const width = size.cols * CELL;
  const height = size.rows * CELL;
  let base = pin.offset;
  if (pin.side && Number.isInteger(pin.slot)) {
    base = slotOffset(size.rows, size.cols, pin.side, pin.slot);
  }
  if (!base) {
    base = { x: 0, y: 0 };
  }
  const rotated = rotatePointInRect(base, width, height, instance.rotation || 0);
  return { x: origin.x + rotated.x, y: origin.y + rotated.y };
}

// 线段是否与元件格边界共线并发生正长度重叠。
// 仅端点/拐点接触边角不算“贴着”；引脚法向出入也不会触发。
export function segmentOverlapsComponentEdge(a, b, component, definitionOptions = {}) {
  const bounds = componentBounds(component, definitionOptions.definitions);
  const x0 = bounds.x;
  const x1 = bounds.x + bounds.w;
  const y0 = bounds.y;
  const y1 = bounds.y + bounds.h;
  if (a.y === b.y && (a.y === y0 || a.y === y1)) {
    const minX = Math.min(a.x, b.x);
    const maxX = Math.max(a.x, b.x);
    return maxX > x0 && minX < x1;
  }
  if (a.x === b.x && (a.x === x0 || a.x === x1)) {
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    return maxY > y0 && minY < y1;
  }
  return false;
}

export function polylineOverlapsComponentEdge(points, components, definitionOptions = {}) {
  if (!Array.isArray(points) || points.length < 2) {
    return false;
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    for (const component of components) {
      if (segmentOverlapsComponentEdge(points[i], points[i + 1], component, { definitions: definitionOptions.definitions })) {
        return true;
      }
    }
  }
  return false;
}
