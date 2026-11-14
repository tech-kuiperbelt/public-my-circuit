// 复制布局策略：锚点以对应网格计数，源原点以世界坐标表示。
import { CELL, WIRE_GRID } from './geometry.js';

function objects(snapshot, kind) {
  return snapshot && Array.isArray(snapshot[kind]) ? snapshot[kind] : [];
}

export function copyGrid(snapshot) {
  return objects(snapshot, 'components').length === 0 &&
    objects(snapshot, 'frames').length === 0 && objects(snapshot, 'wires').length > 0
    ? WIRE_GRID : CELL;
}

export function copySourceOrigin(snapshot) {
  const components = objects(snapshot, 'components');
  if (components.length > 0) {
    return {
      x: Math.min(...components.map((item) => item.cx)) * CELL,
      y: Math.min(...components.map((item) => item.cy)) * CELL
    };
  }
  const frames = objects(snapshot, 'frames');
  const points = frames.length > 0 ? frames :
    objects(snapshot, 'wires').flatMap((wire) => wire.points || []);
  return points.length > 0 ? {
    x: Math.min(...points.map((point) => point.x)),
    y: Math.min(...points.map((point) => point.y))
  } : null;
}

export function copyAnchorAt(snapshot, world) {
  const grid = copyGrid(snapshot);
  return { cx: Math.floor(world.x / grid), cy: Math.floor(world.y / grid) };
}
