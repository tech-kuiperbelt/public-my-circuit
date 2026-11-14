// 职责：电线折线的纯几何工具（正交段、段内部、折线内部、展开、简化、方向）。
export function isOrthogonalSegment(a, b) {
  return a.x === b.x || a.y === b.y;
}

export function pointOnSegmentInterior(p, a, b) {
  if (a.x === b.x && a.y === b.y) {
    return false;
  }
  if (a.x === b.x) {
    return p.x === a.x && Math.min(a.y, b.y) < p.y && p.y < Math.max(a.y, b.y);
  }
  if (a.y === b.y) {
    return p.y === a.y && Math.min(a.x, b.x) < p.x && p.x < Math.max(a.x, b.x);
  }
  return false;
}

export function pointOnPolylineInterior(points, p) {
  for (let i = 0; i < points.length - 1; i += 1) {
    if (pointOnSegmentInterior(p, points[i], points[i + 1])) {
      return { on: true, index: i };
    }
  }
  return { on: false };
}

function samePoint(a, b) {
  return a.x === b.x && a.y === b.y;
}

function dedupeConsecutive(points) {
  const out = [];
  for (const point of points) {
    if (out.length === 0 || !samePoint(out[out.length - 1], point)) {
      out.push({ x: point.x, y: point.y });
    }
  }
  return out;
}

export function polylinePoints(points) {
  if (!points || points.length === 0) {
    return [];
  }
  const expanded = [{ x: points[0].x, y: points[0].y }];
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    if (!isOrthogonalSegment(a, b)) {
      throw new Error('polylinePoints: non-orthogonal segment');
    }
    const dx = Math.sign(b.x - a.x);
    const dy = Math.sign(b.y - a.y);
    let x = a.x;
    let y = a.y;
    while (x !== b.x || y !== b.y) {
      x += dx;
      y += dy;
      expanded.push({ x, y });
    }
  }
  return dedupeConsecutive(expanded);
}

export function simplify(points) {
  const deduped = dedupeConsecutive(points || []);
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
  return dedupeConsecutive(out);
}

// 线段可平移的坐标轴：水平段沿 y 平移，竖直段沿 x 平移（垂直于自身走向）。
function dragAxis(a, b) {
  if (a.y === b.y && a.x !== b.x) {
    return 'y';
  }
  if (a.x === b.x && a.y !== b.y) {
    return 'x';
  }
  return null;
}

// 第 index 段的可平移轴：水平段沿 y，竖直段沿 x；非法折线返回 null。
// 不限制平移量：相邻段允许缩短到 0（简化时合并），也允许反向形成新的折线；
// 最终合法性交给 commands 侧的不变量校验。
export function segmentDragAxis(points, index) {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }
  if (!Number.isInteger(index) || index < 0 || index > points.length - 2) {
    return null;
  }
  for (const point of points) {
    if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) {
      return null;
    }
  }
  for (let i = 0; i < points.length - 1; i += 1) {
    if (dragAxis(points[i], points[i + 1]) === null) {
      return null;
    }
  }

  const axis = dragAxis(points[index], points[index + 1]);
  if (!axis) {
    return null;
  }
  const perpendicularAxis = axis === 'y' ? 'x' : 'y';

  // 相邻段必须垂直于被拖段；否则不是规范的交替正交折线。
  if (index > 0) {
    if (points[index - 1][perpendicularAxis] !== points[index][perpendicularAxis]) {
      return null;
    }
  }
  if (index < points.length - 2) {
    if (points[index + 1][perpendicularAxis] !== points[index + 2][perpendicularAxis]) {
      return null;
    }
  }
  return axis;
}

// 线段平移（端点是否固定由 options.fixStart / fixEnd 决定，默认都固定）：
// - 两侧都有拐角：只移动该段两个端点，不主动增删拐点（相邻段收拢时由简化合并）；
// - 该段触及端点且该端固定：在端点一侧补一个拐点；
// - 该段触及端点且该端可动：端点跟着线段平移，不补拐点；
// - 整根线只有一段：按两端各自的固定/可动组合处理。
// 入参和返回值都不共享可变对象。
export function translateSegment(points, index, delta, options) {
  const axis = segmentDragAxis(points, index);
  if (!axis || !Number.isInteger(delta)) {
    return null;
  }
  const opts = options || {};
  const fixStart = opts.fixStart !== false;
  const fixEnd = opts.fixEnd !== false;
  const clone = function (point) {
    return { x: point.x, y: point.y };
  };
  const shift = function (point) {
    const out = clone(point);
    out[axis] += delta;
    return out;
  };

  if (delta === 0) {
    return { points: points.map(clone), delta: 0 };
  }

  const n = points.length;
  if (n === 2) {
    if (fixStart && fixEnd) {
      const points2 = [clone(points[0]), shift(points[0]), shift(points[1]), clone(points[1])];
      return { points: simplify(points2), delta };
    }
    if (fixStart) {
      return { points: simplify([clone(points[0]), shift(points[0]), shift(points[1])]), delta };
    }
    if (fixEnd) {
      return { points: simplify([shift(points[0]), shift(points[1]), clone(points[1])]), delta };
    }
    return { points: [shift(points[0]), shift(points[1])], delta };
  }

  if (index === 0) {
    if (!fixStart) {
      const out = [shift(points[0]), shift(points[1])];
      for (let i = 2; i < n; i += 1) {
        out.push(clone(points[i]));
      }
      return { points: simplify(out), delta };
    }
    const out = [clone(points[0]), shift(points[0]), shift(points[1])];
    for (let i = 2; i < n; i += 1) {
      out.push(clone(points[i]));
    }
    return { points: simplify(out), delta };
  }

  if (index === n - 2) {
    if (!fixEnd) {
      const out = [];
      for (let i = 0; i < n - 1; i += 1) {
        out.push(clone(points[i]));
      }
      out[n - 2] = shift(points[n - 2]);
      out.push(shift(points[n - 1]));
      return { points: simplify(out), delta };
    }
    const out = [];
    for (let i = 0; i < index; i += 1) {
      out.push(clone(points[i]));
    }
    out.push(shift(points[index]), shift(points[n - 1]), clone(points[n - 1]));
    return { points: simplify(out), delta };
  }

  const out = points.map(clone);
  out[index] = shift(points[index]);
  out[index + 1] = shift(points[index + 1]);
  return { points: simplify(out), delta };
}

export function segmentDirection(a, b) {
  if (a.x === b.x && a.y === b.y) {
    return { x: 0, y: 0 };
  }
  if (a.x === b.x) {
    return { x: 0, y: Math.sign(b.y - a.y) };
  }
  if (a.y === b.y) {
    return { x: Math.sign(b.x - a.x), y: 0 };
  }
  throw new Error('segmentDirection: non-orthogonal segment');
}

function key(point) {
  return point.x + ',' + point.y;
}

// 折线顶点集合（含两端）。
export function polylineVertexKeys(points) {
  const set = new Set();
  for (const point of points || []) {
    set.add(key(point));
  }
  return set;
}

// 两根折线的“垂直穿越”点：交点严格位于双方某段内部，且不是任一方折线的顶点。
export function findWireCrossings(aPoints, bPoints) {
  const out = [];
  if (!aPoints || !bPoints) {
    return out;
  }
  const aVertices = polylineVertexKeys(aPoints);
  const bVertices = polylineVertexKeys(bPoints);

  for (let i = 0; i < aPoints.length - 1; i += 1) {
    const a1 = aPoints[i];
    const a2 = aPoints[i + 1];
    for (let j = 0; j < bPoints.length - 1; j += 1) {
      const b1 = bPoints[j];
      const b2 = bPoints[j + 1];

      const aHorizontal = a1.y === a2.y && a1.x !== a2.x;
      const bHorizontal = b1.y === b2.y && b1.x !== b2.x;
      if (aHorizontal === bHorizontal) {
        continue;
      }

      let point;
      if (aHorizontal) {
        const minX = Math.min(a1.x, a2.x);
        const maxX = Math.max(a1.x, a2.x);
        const minY = Math.min(b1.y, b2.y);
        const maxY = Math.max(b1.y, b2.y);
        if (!(minX < b1.x && b1.x < maxX && minY < a1.y && a1.y < maxY)) {
          continue;
        }
        point = { x: b1.x, y: a1.y };
      } else {
        const minX = Math.min(b1.x, b2.x);
        const maxX = Math.max(b1.x, b2.x);
        const minY = Math.min(a1.y, a2.y);
        const maxY = Math.max(a1.y, a2.y);
        if (!(minX < a1.x && a1.x < maxX && minY < b1.y && b1.y < maxY)) {
          continue;
        }
        point = { x: a1.x, y: b1.y };
      }

      if (aVertices.has(key(point)) || bVertices.has(key(point))) {
        continue;
      }
      out.push(point);
    }
  }
  return out;
}

// 所有导线之间的交叉点；后创建（id 较大）的线画在上层。
export function findCrossings(state) {
  const ids = Object.keys((state && state.wires) || {}).sort();
  const out = [];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const a = state.wires[ids[i]];
      const b = state.wires[ids[j]];
      const points = findWireCrossings(a.points, b.points);
      for (const point of points) {
        out.push({ point, underWireId: ids[i], overWireId: ids[j] });
      }
    }
  }
  return out;
}
