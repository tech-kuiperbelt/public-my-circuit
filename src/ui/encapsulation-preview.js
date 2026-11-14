// 封装预览：独立画布命中、缩放与拖动。
import { draftDisplayName } from "./encapsulation-model.js";
import { slotOffset } from '../core/geometry.js';
import { drawDefinitionPreview, previewPortSlots, previewZoomBounds } from './view.js';

// context 显式注入所需的应用对象、元素、服务与跨模块回调。
export function createPreview(context) {
  let previewPortDrag = null;
  let previewHoverPortId = null;
  function resetInteraction() { previewPortDrag = null; previewHoverPortId = null; }

  function draftPreviewDefinition(draft) {
    return {
      id: '__draft_preview__',
      name: draftDisplayName(draft),
      icon: draft.icon || null,
      size: { rows: draft.rows, cols: draft.cols },
      ports: draft.ports
    };
  }

  function previewPortTarget(draft, clientX, clientY, portId) {
    if (!draft || !context.encapPreview) {
      return null;
    }
    const rect = context.encapPreview.getBoundingClientRect();
    if (clientX < rect.left - 8 || clientX > rect.right + 8 ||
        clientY < rect.top - 8 || clientY > rect.bottom + 8 ||
        rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const slots = previewPortSlots(rect.width, rect.height, draftPreviewDefinition(draft), draft.previewZoom);
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    let best = null;
    for (const slot of slots) {
      const dx = localX - slot.point.x;
      const dy = localY - slot.point.y;
      const distance = Math.hypot(dx, dy);
      if (distance > 16) continue;
      if (!best || distance < best.distance) {
        best = {
          side: slot.side,
          slot: slot.slot,
          portId: slot.portId,
          valid: !slot.portId || slot.portId === portId,
          distance,
          point: slot.point
        };
      }
    }
    return best;
  }

  function previewPinAt(clientX, clientY) {
    const slots = context.app.previewPortSlots();
    let best = null;
    for (const slot of slots) {
      if (!slot.portId) continue;
      const distance = Math.hypot(clientX - slot.clientX, clientY - slot.clientY);
      if (distance > 10) continue;
      if (!best || distance < best.distance) {
        best = Object.assign({}, slot, { distance });
      }
    }
    return best;
  }

  function releasePreviewCapture(event) {
    try {
      if (context.encapPreview.hasPointerCapture && context.encapPreview.hasPointerCapture(event.pointerId)) {
        context.encapPreview.releasePointerCapture(event.pointerId);
      }
    } catch (error) {
      // 忽略。
    }
  }

  function handlePreviewPointerDown(event) {
    if (event.button !== 0 || !context.app.draft) {
      return;
    }
    if (context.app.getMode() === 'erase-port') {
      const erasePin = previewPinAt(event.clientX, event.clientY);
      if (erasePin) {
        context.app.removePort(erasePin.portId);
        context.app.render();
      }
      return;
    }
    const pin = previewPinAt(event.clientX, event.clientY);
    if (!pin) {
      if (context.app.selection.kind === 'port') {
        context.app.setSelection({ kind: null, id: null });
        context.app.render();
      }
      return;
    }
    event.preventDefault();
    context.app.setSelection({ kind: 'port', id: pin.portId });
    context.app.render();
    if (context.app.isReadOnlyDraft()) {
      return;
    }
    previewPortDrag = {
      portId: pin.portId,
      start: { x: event.clientX, y: event.clientY },
      moved: false,
      pointerId: event.pointerId
    };
    try {
      context.encapPreview.setPointerCapture(event.pointerId);
    } catch (error) {
      // 忽略。
    }
  }

  function handlePreviewPointerMove(event) {
    if (!previewPortDrag) {
      updatePreviewHover(event.clientX, event.clientY);
      return;
    }
    const dx = event.clientX - previewPortDrag.start.x;
    const dy = event.clientY - previewPortDrag.start.y;
    if (!previewPortDrag.moved && Math.hypot(dx, dy) >= 4) {
      previewPortDrag.moved = true;
    }
    if (!previewPortDrag.moved) {
      return;
    }
    const target = context.app.previewPortTarget(event.clientX, event.clientY, previewPortDrag.portId);
    context.app.setPortDrag(previewPortDrag.portId, target);
    event.preventDefault();
  }

  function updatePreviewHover(clientX, clientY) {
    if (!context.app.draft) {
      return;
    }
    const pin = previewPinAt(clientX, clientY);
    const portId = pin ? pin.portId : null;
    if (portId === previewHoverPortId) {
      return;
    }
    previewHoverPortId = portId;
    renderDraftPreview();
  }

  function handlePreviewPointerLeave() {
    if (previewHoverPortId === null) {
      return;
    }
    previewHoverPortId = null;
    renderDraftPreview();
  }

  function handlePreviewPointerUp(event) {
    if (!previewPortDrag) {
      return;
    }
    const drag = previewPortDrag;
    previewPortDrag = null;
    if (drag.moved) {
      context.app.dropPortAt(event.clientX, event.clientY, drag.portId);
    } else {
      context.app.setPortDrag(null);
    }
    releasePreviewCapture(event);
    context.app.render();
  }

  function handlePreviewPointerCancel(event) {
    if (!previewPortDrag) {
      return;
    }
    previewPortDrag = null;
    context.app.setPortDrag(null);
    releasePreviewCapture(event);
    context.app.render();
  }

  function handlePreviewWheel(event) {
    if (!context.app.draft) {
      return;
    }
    event.preventDefault();
    const draft = context.app.draft;
    const factor = Math.exp(-event.deltaY * 0.0015);
    const current = Number.isFinite(draft.previewZoom) ? draft.previewZoom : 1;
    draft.previewZoom = Math.max(0.1, current * factor);
    renderDraftPreview();
  }

  function handlePreviewDoubleClick(event) {
    if (event.button !== 0 || !context.app.draft || context.app.getMode() === 'erase-port') {
      return;
    }
    const label = context.app.previewPortLabelAt ? context.app.previewPortLabelAt(event.clientX, event.clientY) : null;
    const pin = label ? null : previewPinAt(event.clientX, event.clientY);
    const portId = label ? label.portId : (pin ? pin.portId : null);
    if (!portId) {
      return;
    }
    event.preventDefault();
    void context.app.editPortLabel(portId);
  }

  function moveDraftPortToSlot(portId, side, slot) {
    const draft = context.app.draft;
    if (!draft || draft.readOnly) {
      return false;
    }
    const port = (draft.ports || []).find(function (item) { return item.id === portId; });
    if (!port) {
      return false;
    }
    if (!slotOffset(draft.rows, draft.cols, side, slot)) {
      return false;
    }
    const occupied = draft.ports.some(function (item) {
      return item !== port && item.side === side && item.slot === slot;
    });
    if (occupied) {
      context.toast.show('该槽位已被其他管脚占用');
      return false;
    }
    port.side = side;
    port.slot = slot;
    context.syncDraftPanel();
    return true;
  }

  function renderDraftPreview() {
    if (!context.encapPreview) {
      return;
    }
    const draft = context.app.draft;
    const rect = context.encapPreview.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    if (draft) {
      const bounds = previewZoomBounds(width, height, draftPreviewDefinition(draft));
      const current = Number.isFinite(draft.previewZoom) ? draft.previewZoom : 1;
      draft.previewZoom = Math.max(bounds.min, Math.min(bounds.max, current));
    }
    const ratio = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * ratio));
    const pixelHeight = Math.max(1, Math.round(height * ratio));
    if (context.encapPreview.width !== pixelWidth || context.encapPreview.height !== pixelHeight) {
      context.encapPreview.width = pixelWidth;
      context.encapPreview.height = pixelHeight;
    }
    const ctx = context.encapPreview.getContext('2d');
    if (!ctx) {
      return;
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!draft) {
      ctx.clearRect(0, 0, width, height);
      return;
    }
    drawDefinitionPreview(
      ctx,
      width,
      height,
      draftPreviewDefinition(draft),
      context.app.selection.kind === 'port' ? context.app.selection.id : null,
      context.app.overlay.portDrag,
      !draft.readOnly,
      draft.previewZoom,
      previewHoverPortId
    );
  }

  return { draftPreviewDefinition, handlePreviewDoubleClick, handlePreviewPointerCancel, handlePreviewPointerDown, handlePreviewPointerLeave, handlePreviewPointerMove, handlePreviewPointerUp, handlePreviewWheel, moveDraftPortToSlot, previewPortTarget, renderDraftPreview, resetInteraction };
}
