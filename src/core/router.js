// 职责：正交自动布线（Dijkstra、避障、交叉闸口、确定性 tie-break）。
import {
  WIRE_GRID,
  componentBounds,
  componentPins,
  isWireGridPoint,
  pinWorld,
  pointInBounds,
  segmentOverlapsComponentEdge
} from './geometry.js';
import { polylinePoints, simplify } from './wire.js';
import { REASONS } from './reasons.js';

const DIRECTIONS = [
  { x: WIRE_GRID, y: 0 },
  { x: -WIRE_GRID, y: 0 },
  { x: 0, y: WIRE_GRID },
  { x: 0, y: -WIRE_GRID }
];

const CROSS_COST = 150;

function pointKey(x, y) {
  return x + ',' + y;
}

function stateKey(x, y, dir) {
  return x + ',' + y + ',' + dir;
}

function dirKey(dir) {
  return dir.x + ',' + dir.y;
}

function isInsideComponent(point, components, definitionOptions = {}) {
  for (const component of components) {
    if (pointInBounds(point, componentBounds(component, definitionOptions.definitions), false)) {
      return true;
    }
  }
  return false;
}

function createMinHeap() {
  const items = [];

  function less(a, b) {
    if (a.cost !== b.cost) {
      return a.cost < b.cost;
    }
    return a.seq < b.seq;
  }

  function swap(i, j) {
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }

  return {
    push(item) {
      items.push(item);
      let index = items.length - 1;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (less(items[index], items[parent])) {
          swap(index, parent);
          index = parent;
        } else {
          break;
        }
      }
    },
    pop() {
      const top = items[0];
      const last = items.pop();
      if (items.length > 0) {
        items[0] = last;
        let index = 0;
        for (;;) {
          const left = index * 2 + 1;
          const right = left + 1;
          let smallest = index;
          if (left < items.length && less(items[left], items[smallest])) {
            smallest = left;
          }
          if (right < items.length && less(items[right], items[smallest])) {
            smallest = right;
          }
          if (smallest === index) {
            break;
          }
          swap(index, smallest);
          index = smallest;
        }
      }
      return top;
    },
    size() {
      return items.length;
    }
  };
}

// 每条导线的展开点元数据：局部方向、是否顶点、是否端点。
// 同时预计算“交叉闸口”：可垂直穿越的点及其上下/左右各一个布线网格，只允许沿穿越方向通行。
function buildWireMeta(state) {
  const meta = new Map();
  const gateDirs = new Map();

  function addGate(key, dir) {
    if (!gateDirs.has(key)) {
      gateDirs.set(key, new Set());
    }
    gateDirs.get(key).add(dirKey(dir));
  }

  for (const wireId of Object.keys(state.wires || {})) {
    const wire = state.wires[wireId];
    const points = wire.points;
    if (!points || points.length < 2) {
      continue;
    }
    const vertices = new Set();
    for (const point of points) {
      vertices.add(pointKey(point.x, point.y));
    }
    const endKeys = new Set([
      pointKey(points[0].x, points[0].y),
      pointKey(points[points.length - 1].x, points[points.length - 1].y)
    ]);

    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i];
      const b = points[i + 1];
      const dir = { x: Math.sign(b.x - a.x), y: Math.sign(b.y - a.y) };
      const steps = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      for (let s = 0; s <= steps; s += 1) {
        const x = a.x + dir.x * s;
        const y = a.y + dir.y * s;
        const key = pointKey(x, y);
        const entry = {
          wireId,
          dir,
          isVertex: vertices.has(key),
          isEndpoint: endKeys.has(key)
        };
        if (!meta.has(key)) {
          meta.set(key, []);
        }
        meta.get(key).push(entry);

        if (entry.isVertex || entry.isEndpoint) {
          continue;
        }
        const perpendicular = dir.x !== 0
          ? [{ x: 0, y: WIRE_GRID }, { x: 0, y: -WIRE_GRID }]
          : [{ x: WIRE_GRID, y: 0 }, { x: -WIRE_GRID, y: 0 }];
        for (const pdir of perpendicular) {
          addGate(key, pdir);
          addGate(pointKey(x + pdir.x, y + pdir.y), pdir);
          addGate(pointKey(x - pdir.x, y - pdir.y), pdir);
        }
      }
    }
  }

  return { meta, gateDirs };
}

function buildObstacles(state, ignoreNetOf, definitionOptions = {}) {
  const components = Object.keys(state.components).map(function (id) {
    return state.components[id];
  });

  const componentList = components.slice();

  const pinSet = new Set();
  const pinClearance = new Set();
  for (const component of components) {
    const defs = componentPins(component, definitionOptions.definitions) || [];
    for (const def of defs) {
      const world = pinWorld(component, def.id, definitionOptions.definitions);
      pinSet.add(pointKey(world.x, world.y));
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          pinClearance.add(pointKey(world.x + dx, world.y + dy));
        }
      }
    }
  }

  const ignored = new Set(ignoreNetOf);
  const exactWire = new Set();
  const clearance = new Set();
  for (const wireId of Object.keys(state.wires)) {
    const wire = state.wires[wireId];
    const points = polylinePoints(wire.points);
    const hasClearance = !ignored.has(wireId);
    for (const point of points) {
      exactWire.add(pointKey(point.x, point.y));
      if (hasClearance) {
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            clearance.add(pointKey(point.x + dx, point.y + dy));
          }
        }
      }
    }
  }

  const edgePenalty = new Set();
  for (const component of components) {
    const bounds = componentBounds(component, definitionOptions.definitions);
    const x0 = bounds.x;
    const y0 = bounds.y;
    const x1 = bounds.x + bounds.w;
    const y1 = bounds.y + bounds.h;
    for (let x = x0 - 2; x <= x1 + 2; x += 1) {
      for (let y = y0 - 2; y <= y1 + 2; y += 1) {
        const inside = x0 < x && x < x1 && y0 < y && y < y1;
        if (!inside) {
          edgePenalty.add(pointKey(x, y));
        }
      }
    }
  }

  return { componentList, pinSet, pinClearance, exactWire, clearance, edgePenalty };
}

// 严格校验：路径与其它导线的每一个接触点都必须是“直穿 + 垂直 + 非顶点/端点 + 单线”。
function validateCrossings(state, points) {
  const { meta } = buildWireMeta(state);
  const expanded = polylinePoints(points);
  if (expanded.length < 3) {
    return true;
  }

  for (let i = 1; i < expanded.length - 1; i += 1) {
    const point = expanded[i];
    const entries = meta.get(pointKey(point.x, point.y));
    if (!entries) {
      continue;
    }
    const interior = entries.filter(function (entry) {
      return !entry.isVertex && !entry.isEndpoint;
    });
    if (interior.length === 0) {
      return false;
    }
    if (interior.length > 1) {
      return false;
    }
    const entry = interior[0];
    const before = {
      x: Math.sign(point.x - expanded[i - 1].x),
      y: Math.sign(point.y - expanded[i - 1].y)
    };
    const after = {
      x: Math.sign(expanded[i + 1].x - point.x),
      y: Math.sign(expanded[i + 1].y - point.y)
    };
    if (before.x !== after.x || before.y !== after.y) {
      return false;
    }
    if (before.x * entry.dir.x + before.y * entry.dir.y !== 0) {
      return false;
    }
  }
  return true;
}

export function route(state, start, goal, opts) {
  const options = opts || {};
  const margin = options.margin === undefined ? 40 : options.margin;
  const maxNodes = options.maxNodes === undefined ? 200000 : options.maxNodes;
  const allowTouching = options.allowTouching || [];
  const ignoreNetOf = options.ignoreNetOf || [];
  const allowCrossing = options.allowCrossing !== false;

  if (!isWireGridPoint(start) || !isWireGridPoint(goal)) {
    return { ok: false, reason: REASONS.NO_ROUTE };
  }

  const obstacles = buildObstacles(state, ignoreNetOf, { definitions: (opts || {}).definitions });
  const { componentList, pinSet, pinClearance, exactWire, clearance, edgePenalty } = obstacles;
  const { gateDirs } = buildWireMeta(state);

  if (isInsideComponent(start, componentList, { definitions: (opts || {}).definitions }) || isInsideComponent(goal, componentList, { definitions: (opts || {}).definitions })) {
    return { ok: false, reason: REASONS.BLOCKED_BY_COMPONENT };
  }

  const allowSet = new Set();
  const allowNear = new Set();
  const touchPoints = [start, goal].concat(allowTouching);
  for (const point of touchPoints) {
    allowSet.add(pointKey(point.x, point.y));
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        allowNear.add(pointKey(point.x + dx, point.y + dy));
      }
    }
  }

  const startX = start.x;
  const startY = start.y;
  const goalX = goal.x;
  const goalY = goal.y;

  function isEndpoint(x, y) {
    return (x === startX && y === startY) || (x === goalX && y === goalY);
  }

  function isGate(x, y, dir) {
    const set = gateDirs.get(pointKey(x, y));
    return Boolean(set && set.has(dirKey(dir)));
  }

  function blocked(x, y, dir, useCrossing, definitionOptions = {}) {
    if (isInsideComponent({ x, y }, componentList, { definitions: definitionOptions.definitions })) {
      return true;
    }
    const previous = { x: x - dir.x, y: y - dir.y };
    for (const component of componentList) {
      if (segmentOverlapsComponentEdge(previous, { x, y }, component, { definitions: definitionOptions.definitions })) {
        return true;
      }
    }
    const key = pointKey(x, y);
    if (pinSet.has(key) && !isEndpoint(x, y)) {
      return true;
    }
    if (pinClearance.has(key) && !allowNear.has(key)) {
      return true;
    }
    const gate = useCrossing && isGate(x, y, dir);
    if (exactWire.has(key) && !allowSet.has(key) && !gate) {
      return true;
    }
    if (clearance.has(key) && !allowNear.has(key) && !gate) {
      return true;
    }
    return false;
  }

  function edgeCost(x, y) {
    return edgePenalty.has(pointKey(x, y)) ? 300 : 0;
  }

  function crossCost(x, y, dir, useCrossing) {
    if (!useCrossing) {
      return 0;
    }
    const key = pointKey(x, y);
    return exactWire.has(key) && isGate(x, y, dir) ? CROSS_COST : 0;
  }

  function search(useCrossing, definitionOptions = {}) {
    if (startX === goalX && startY === goalY) {
      return { ok: true, points: [{ x: startX, y: startY }] };
    }

    const minX = Math.min(startX, goalX) - margin;
    const maxX = Math.max(startX, goalX) + margin;
    const minY = Math.min(startY, goalY) - margin;
    const maxY = Math.max(startY, goalY) + margin;

    function inBounds(x, y) {
      return x >= minX && x <= maxX && y >= minY && y <= maxY;
    }

    const heap = createMinHeap();
    const best = new Map();
    const prevOf = new Map();
    let seq = 0;

    for (let dir = 0; dir < DIRECTIONS.length; dir += 1) {
      const step = DIRECTIONS[dir];
      const nx = startX + step.x;
      const ny = startY + step.y;
      if (!inBounds(nx, ny) || blocked(nx, ny, step, useCrossing, { definitions: definitionOptions.definitions })) {
        continue;
      }
      const key = stateKey(nx, ny, dir);
      const cost = 1000 + edgeCost(nx, ny) + crossCost(nx, ny, step, useCrossing);
      if (best.has(key) && best.get(key) <= cost) {
        continue;
      }
      best.set(key, cost);
      prevOf.set(key, null);
      heap.push({ cost, seq, x: nx, y: ny, dir });
      seq += 1;
    }

    const visited = new Set();
    let expanded = 0;
    let goalState = null;

    while (heap.size() > 0) {
      const node = heap.pop();
      const key = stateKey(node.x, node.y, node.dir);
      if (best.get(key) !== node.cost) {
        continue;
      }
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      expanded += 1;
      if (expanded > maxNodes) {
        return { ok: false, reason: REASONS.NO_ROUTE };
      }

      if (node.x === goalX && node.y === goalY) {
        goalState = { key };
        break;
      }

      for (let dir = 0; dir < DIRECTIONS.length; dir += 1) {
        const step = DIRECTIONS[dir];
        const nx = node.x + step.x;
        const ny = node.y + step.y;
        if (!inBounds(nx, ny) || blocked(nx, ny, step, useCrossing, { definitions: definitionOptions.definitions })) {
          continue;
        }
        const turn = dir === node.dir ? 0 : 1;
        const cost =
          node.cost + 1000 + turn + edgeCost(nx, ny) + crossCost(nx, ny, step, useCrossing);
        const nextKey = stateKey(nx, ny, dir);
        if (best.has(nextKey) && best.get(nextKey) <= cost) {
          continue;
        }
        best.set(nextKey, cost);
        prevOf.set(nextKey, key);
        heap.push({ cost, seq, x: nx, y: ny, dir });
        seq += 1;
      }
    }

    if (goalState === null) {
      return { ok: false, reason: REASONS.NO_ROUTE };
    }

    const reversed = [];
    let cursor = goalState.key;
    while (cursor) {
      const parts = cursor.split(',');
      reversed.push({ x: Number(parts[0]), y: Number(parts[1]) });
      cursor = prevOf.get(cursor);
    }
    reversed.reverse();
    const points = simplify([{ x: startX, y: startY }].concat(reversed));
    return { ok: true, points };
  }

  if (allowCrossing) {
    const relaxed = search(true, { definitions: (opts || {}).definitions });
    if (relaxed.ok && validateCrossings(state, relaxed.points)) {
      return relaxed;
    }
  }

  return search(false, { definitions: (opts || {}).definitions });
}

export { validateCrossings, buildWireMeta };
