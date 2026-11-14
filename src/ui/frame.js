// 职责：分组框的屏幕布局与标签样式；纯函数，供渲染和命中共用。
import { FRAME_DEFAULT_COLOR, FRAME_DEFAULT_LABEL } from '../core/entities.js';

export const FRAME_LABEL_HEIGHT = 22;
export const FRAME_LABEL_FONT = 'bold 12px system-ui, -apple-system, "Segoe UI", sans-serif';
const FRAME_LABEL_MIN_WIDTH = 56;
const FRAME_LABEL_CHAR_WIDTH = 12;
const FRAME_LABEL_PADDING = 16;

export function frameColor(frame) {
  return frame && typeof frame.color === 'string'
    ? frame.color
    : FRAME_DEFAULT_COLOR;
}

export function frameLabel(frame) {
  return frame && typeof frame.label === 'string' && frame.label
    ? frame.label
    : FRAME_DEFAULT_LABEL;
}

// 标签文字在实际字形包围盒内水平/垂直居中；metrics 来自 ctx.measureText。
export function frameLabelTextLayout(rect, textWidth, ascent, descent) {
  const width = Number.isFinite(textWidth) ? textWidth : 0;
  const up = Number.isFinite(ascent) ? ascent : 0;
  const down = Number.isFinite(descent) ? descent : 0;
  return {
    x: rect.x + (rect.width - width) / 2,
    baseline: rect.y + (rect.height - (up + down)) / 2 + up
  };
}

export function frameScreenRect(frame, view) {
  const scale = view && Number.isFinite(view.scale) ? view.scale : 1;
  const pan = view && view.pan ? view.pan : { x: 0, y: 0 };
  return {
    x: frame.x * scale + pan.x,
    y: frame.y * scale + pan.y,
    width: frame.w * scale,
    height: frame.h * scale
  };
}

// 标签贴在框内右下角；宽度按字符数估算，渲染和命中使用同一结果。
export function frameLabelRect(frame, view) {
  const rect = frameScreenRect(frame, view);
  const text = frameLabel(frame);
  const rawWidth = Math.max(
    FRAME_LABEL_MIN_WIDTH,
    text.length * FRAME_LABEL_CHAR_WIDTH + FRAME_LABEL_PADDING
  );
  const width = Math.max(1, Math.min(rect.width, rawWidth));
  return {
    x: rect.x + rect.width - width,
    y: rect.y + rect.height - FRAME_LABEL_HEIGHT,
    width,
    height: FRAME_LABEL_HEIGHT
  };
}

// 两个对角点 -> 左上角 + 正宽高；用于框选创建。
export function normalizeFrameRect(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y)
  };
}
