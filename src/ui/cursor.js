// 职责：激活元件/工具后，把画布光标替换成对应栏位图标。
// cursorSpec 是纯函数（可单测）；itemCursor 只在浏览器里生成 data URL。
import { itemLabel } from './toolbar.js';

export function cursorSpec(mode, type) {
  if (mode === 'place' && type) {
    return { kind: 'tool', type };
  }
  if (mode === 'delete') {
    return { kind: 'tool', type: 'DELETE' };
  }
  if (mode === 'wire') {
    return { kind: 'tool', type: 'WIRE' };
  }
  if (mode === 'frame') {
    return { kind: 'tool', type: 'FRAME' };
  }
  if (mode === 'copy') {
    return { kind: 'tool', type: 'COPY' };
  }
  if (mode === 'erase-port') {
    return { kind: 'eraser' };
  }
  return { kind: 'default' };
}

const cache = new Map();

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
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

function withGlyph(ctx, draw) {
  ctx.save();
  ctx.translate(6, 6);
  ctx.scale(20 / 24, 20 / 24);
  ctx.strokeStyle = '#e8e8e8';
  ctx.fillStyle = '#e8e8e8';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  draw(ctx);
  ctx.restore();
}

function drawComponentGlyph(type, ctx) {
  if (type === 'CONST1') {
    withGlyph(ctx, function (g) {
      roundedRect(g, 3, 3, 18, 18, 2);
      g.stroke();
      g.font = 'bold 13px system-ui, -apple-system, "Segoe UI", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('1', 12, 12.5);
    });
    return true;
  }
  if (type === 'TOGGLE') {
    withGlyph(ctx, function (g) {
      roundedRect(g, 3, 8, 18, 8, 4);
      g.stroke();
      g.beginPath();
      g.arc(16, 12, 2.5, 0, Math.PI * 2);
      g.stroke();
    });
    return true;
  }
  if (type === 'BUTTON') {
    withGlyph(ctx, function (g) {
      g.beginPath();
      g.arc(12, 10, 6, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.arc(12, 10, 2.5, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(6, 19);
      g.lineTo(18, 19);
      g.stroke();
    });
    return true;
  }
  if (type === 'CLOCK') {
    withGlyph(ctx, function (g) {
      roundedRect(g, 3, 4, 18, 16, 2);
      g.stroke();
      g.beginPath();
      g.moveTo(5, 15);
      g.lineTo(8, 15);
      g.lineTo(8, 9);
      g.lineTo(12, 9);
      g.lineTo(12, 15);
      g.lineTo(16, 15);
      g.lineTo(16, 9);
      g.lineTo(19, 9);
      g.stroke();
    });
    return true;
  }
  if (type === 'NOT') {
    withGlyph(ctx, function (g) {
      g.beginPath();
      g.moveTo(5, 5);
      g.lineTo(5, 19);
      g.lineTo(17, 12);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.arc(19, 12, 2, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(2, 12);
      g.lineTo(5, 12);
      g.moveTo(21, 12);
      g.lineTo(22, 12);
      g.stroke();
    });
    return true;
  }
  if (type === 'DELAY') {
    withGlyph(ctx, function (g) {
      g.beginPath();
      g.moveTo(2, 12);
      g.lineTo(5, 12);
      g.moveTo(19, 12);
      g.lineTo(22, 12);
      g.stroke();
      roundedRect(g, 5, 5, 14, 14, 1);
      g.stroke();
      g.font = '12px Georgia, "Times New Roman", serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('τ', 12, 12.5);
    });
    return true;
  }
  if (type === 'AND') {
    withGlyph(ctx, function (g) {
      g.beginPath();
      g.moveTo(4, 4);
      g.lineTo(11, 4);
      g.quadraticCurveTo(19, 4, 19, 12);
      g.quadraticCurveTo(19, 20, 11, 20);
      g.lineTo(4, 20);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(2, 9);
      g.lineTo(4, 9);
      g.moveTo(2, 15);
      g.lineTo(4, 15);
      g.moveTo(19, 12);
      g.lineTo(22, 12);
      g.stroke();
    });
    return true;
  }
  if (type === 'OR') {
    withGlyph(ctx, function (g) {
      g.beginPath();
      g.moveTo(4, 4);
      g.quadraticCurveTo(7, 7, 7, 12);
      g.quadraticCurveTo(7, 17, 4, 20);
      g.quadraticCurveTo(11, 20, 20, 12);
      g.quadraticCurveTo(11, 4, 4, 4);
      g.closePath();
      g.stroke();
      g.beginPath();
      g.moveTo(2, 9);
      g.lineTo(5, 9);
      g.moveTo(2, 15);
      g.lineTo(5, 15);
      g.moveTo(20, 12);
      g.lineTo(22, 12);
      g.stroke();
    });
    return true;
  }
  if (type === 'WIRE') {
    withGlyph(ctx, function (g) {
      g.beginPath();
      g.moveTo(3, 17);
      g.lineTo(11, 17);
      g.lineTo(11, 7);
      g.lineTo(21, 7);
      g.stroke();
      g.beginPath();
      g.arc(3, 17, 1.5, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.arc(21, 7, 1.5, 0, Math.PI * 2);
      g.fill();
    });
    return true;
  }
  if (type === 'LAMP') {
    withGlyph(ctx, function (g) {
      g.beginPath();
      g.arc(12, 9.5, 5.5, 0, Math.PI * 2);
      g.stroke();
      g.beginPath();
      g.moveTo(9, 14);
      g.lineTo(9, 18);
      g.lineTo(15, 18);
      g.lineTo(15, 14);
      g.stroke();
      g.beginPath();
      g.moveTo(10, 21);
      g.lineTo(14, 21);
      g.stroke();
    });
    return true;
  }
  if (type === 'FRAME') {
    withGlyph(ctx, function (g) {
      g.save();
      g.setLineDash([3, 2]);
      roundedRect(g, 3, 3, 18, 14, 1);
      g.stroke();
      g.restore();
      g.fillRect(13, 12, 8, 5);
    });
    return true;
  }
  return false;
}

function drawCopyGlyph(ctx) {
  ctx.save();
  ctx.translate(6, 6);
  ctx.scale(20 / 24, 20 / 24);
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  roundedRect(ctx, 8, 8, 12, 13, 2);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(16, 8);
  ctx.lineTo(16, 6);
  ctx.quadraticCurveTo(16, 4, 14, 4);
  ctx.lineTo(6, 4);
  ctx.quadraticCurveTo(4, 4, 4, 6);
  ctx.lineTo(4, 15);
  ctx.quadraticCurveTo(4, 17, 6, 17);
  ctx.lineTo(8, 17);
  ctx.stroke();
  ctx.restore();
}

function drawDeleteGlyph(ctx) {
  ctx.save();
  ctx.translate(6, 6);
  ctx.scale(20 / 24, 20 / 24);
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(4, 7);
  ctx.lineTo(20, 7);
  ctx.moveTo(10, 11);
  ctx.lineTo(10, 17);
  ctx.moveTo(14, 11);
  ctx.lineTo(14, 17);
  ctx.moveTo(6, 7);
  ctx.lineTo(7, 19);
  ctx.quadraticCurveTo(7.2, 21, 9, 21);
  ctx.lineTo(15, 21);
  ctx.quadraticCurveTo(16.8, 21, 17, 19);
  ctx.lineTo(18, 7);
  ctx.moveTo(9, 7);
  ctx.lineTo(9, 5);
  ctx.quadraticCurveTo(9, 3, 11, 3);
  ctx.lineTo(13, 3);
  ctx.quadraticCurveTo(15, 3, 15, 5);
  ctx.lineTo(15, 7);
  ctx.stroke();
  ctx.restore();
}

export function eraserCursor() {
  const cacheKey = '__eraser__';
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return 'default';
  }
  roundedRect(ctx, 1.5, 1.5, size - 3, size - 3, 6);
  ctx.fillStyle = '#2a2a2a';
  ctx.fill();
  ctx.strokeStyle = '#8a8a8a';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(-Math.PI / 4);
  roundedRect(ctx, -10, -5, 20, 10, 2);
  ctx.fillStyle = '#f2b8c6';
  ctx.fill();
  ctx.strokeStyle = '#e8e8e8';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(1, -5);
  ctx.lineTo(1, 5);
  ctx.stroke();
  ctx.restore();

  const cursor = 'url(' + canvas.toDataURL('image/png') + ') 16 16, auto';
  cache.set(cacheKey, cursor);
  return cursor;
}

// 与栏位图标一致的样式，返回可直接赋给 style.cursor 的字符串。
export function itemCursor(type) {
  const label = itemLabel(type);
  if (!label) {
    return 'default';
  }
  const cacheKey = type || label;
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey);
  }

  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return 'default';
  }

  roundedRect(ctx, 1.5, 1.5, size - 3, size - 3, 6);
  ctx.fillStyle = '#2a2a2a';
  ctx.fill();
  ctx.strokeStyle = '#8a8a8a';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (type === 'COPY') {
    drawCopyGlyph(ctx);
  } else if (type === 'DELETE') {
    drawDeleteGlyph(ctx);
  } else if (!drawComponentGlyph(type, ctx)) {
    ctx.fillStyle = '#e8e8e8';
    ctx.font = 'bold ' + (label.length > 1 ? 12 : 17) + 'px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, size / 2, size / 2 + 1);
  }

  const cursor = 'url(' + canvas.toDataURL('image/png') + ') 16 16, auto';
  cache.set(cacheKey, cursor);
  return cursor;
}
