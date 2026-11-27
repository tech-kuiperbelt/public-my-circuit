// 职责：鼠标/键盘输入 -> 编辑意图；所有修改都通过 app.commit(命令结果) 提交。
import {
  CELL,
  componentBounds,
  pointInBounds,
  snapToWireGrid
} from '../core/geometry.js';
import { copyAnchorAt } from '../core/copy-layout.js';
import { isPinConnected, pinWireEnd } from '../core/validate.js';
import {
  canAutoRouteSelection,
  canCopySelection,
  canRotateSelection,
  selectionCustomDefinitionId,
  selectionFromObjects,
  selectionObjects,
  toggleSelectionObject,
  unionSelection
} from './selection.js';
import { REASONS } from '../core/reasons.js';
import { getOscillationHighlight } from './oscillation-highlight.js';
import { FRAME_DEFAULT_COLOR, FRAME_DEFAULT_LABEL } from '../core/entities.js';
import {
  autoRouteWires,
  connect,
  placeComponent,
  previewConnect,
  moveComponent,
  removeComponentCommand,
  removeSelectionCommand,
  rotateSelectionCommand,
  previewCopySelection,
  copySelectionCommand,
  moveSelectionCommand,
  deleteWire,
  toggleComponent,
  setButtonPressed,
  rotateComponent,
  previewDragWireSegment,
  dragWireSegment,
  previewAttachFreeEnd,
  attachFreeEnd,
  previewMoveFreeEnd,
  moveFreeEnd,
  previewCreateFreeWire,
  createFreeWire,
  previewCreateAnchoredFreeWire,
  createAnchoredFreeWire,
  previewExtendFreeWire,
  extendFreeWire,
  previewMergeFreeEnds,
  mergeFreeEnds,
  previewDetachPinEnd,
  detachPinEnd,
  previewDetachJunctionEnd,
  detachJunctionEnd,
  previewReconnectJunctionEnd,
  reconnectJunctionEnd,
  addFrameCommand,
  updateFrameCommand,
  moveFrameCommand,
  removeFrameCommand
} from '../core/commands.js';
import { screenToWorld, zoomAt } from './view.js';
import {
  componentsInRect,
  freeLineEnd,
  hitToggleSwitch,
  hitButtonSwitch,
  nearestAnnotatable,
  nearestFreeEnd,
  nearestJunctionEnd,
  nearestPin,
  nearestWirePoint,
  resolveAnchor,
  rubberPoints,
  wiresInRect,
  framesInRect,
  hitFrame
} from './hit.js';
import { normalizeFrameRect } from './frame.js';

function eventScreenPoint(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

function distanceToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSq = dx * dx + dy * dy;
  let t = 0;
  if (lengthSq > 0) {
    t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
  }
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function hitComponent(state, world, definitionOptions = {}) {
  const ids = Object.keys(state.components);
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const component = state.components[ids[i]];
    if (pointInBounds(world, componentBounds(component, definitionOptions.definitions), true)) {
      return ids[i];
    }
  }
  return null;
}

function hitWire(state, view, screen) {
  const world = screenToWorld(screen, view);
  const tolerance = Math.max(1, 6 / view.scale);
  let best = null;
  for (const wireId of Object.keys(state.wires)) {
    const wire = state.wires[wireId];
    const points = wire.points;
    if (!points || points.length < 2) {
      continue;
    }
    for (let i = 0; i < points.length - 1; i += 1) {
      const dist = distanceToSegment(world, points[i], points[i + 1]);
      if (dist <= tolerance && (!best || dist < best.dist)) {
        best = { id: wireId, index: i, dist };
      }
    }
  }
  return best;
}

export function attachInput(options) {
  const canvas = options.canvas;
  const app = options.app;
  const toast = options.toast;
  const menu = options.menu;
  const frameForm = options.frameForm;

  let spaceHeld = false;
  let panDrag = null;
  let componentDrag = null;
  let wireDrag = null;
  let endpointDrag = null;
  let freeDraw = null;
  let marquee = null;
  let groupDrag = null;
  // 复制会话只有一种阶段；pending 只记录手势，placing 才持有独立源快照。
  let copySession = { phase: 'idle' };
  let armed = null;
  let hoverKey = '';
  let hoverPinKey = '';
  let hoverComponentKey = '';
  let lastScreen = null;
  let rubberFrame = null;
  let frameDraw = null;
  let frameDrag = null;
  let portDrag = null;
  let activeButton = null;
  let restoredButtons = new Set();

  // Ctrl/Cmd 按住时保持当前工具激活，便于连续创建（元件、导线、分组框一致）。
  function isKeepActive(event) {
    return Boolean(event && (event.ctrlKey || event.metaKey));
  }

  function setHover(point) {
    const key = point ? point.x + ',' + point.y : '';
    if (key === hoverKey) {
      return;
    }
    hoverKey = key;
    app.overlay.hoverAnchor = point ? { x: point.x, y: point.y } : null;
    app.render();
  }

  function setPinHover(pin, screen) {
    const key = pin ? pin.componentId + ':' + pin.pinId : '';
    if (key === hoverPinKey) {
      return;
    }
    hoverPinKey = key;
    if (app.setHoverPin) {
      app.setHoverPin(pin, screen);
    }
  }

  function setComponentHover(componentId, screen) {
    const key = componentId || '';
    if (key === hoverComponentKey) {
      return;
    }
    hoverComponentKey = key;
    if (app.setHoverComponent) {
      app.setHoverComponent(componentId, screen);
    }
  }

  function clearOverlays() {
    app.overlay.preview = null;
    app.overlay.hoverAnchor = null;
    app.overlay.dragGhost = null;
    app.overlay.wireStart = null;
    app.overlay.rubber = null;
    app.overlay.wireDrag = null;
    app.overlay.endpointDrag = null;
    app.overlay.marquee = null;
    app.overlay.groupDrag = null;
    marquee = null;
    groupDrag = null;
    frameDraw = null;
    frameDrag = null;
    app.overlay.frameDraw = null;
    app.overlay.frameDrag = null;
    resetCopySession();
    hoverKey = '';
    hoverPinKey = '';
    hoverComponentKey = '';
    if (app.setHoverPin) {
      app.setHoverPin(null);
    }
    if (app.setHoverComponent) {
      app.setHoverComponent(null);
    }
  }

  function cancelInputGestures(options) {
    releaseActiveButton({ discard: Boolean(options && options.discardButton) });
    cancelRubberFrame();
    armed = null;
    lastScreen = null;
    componentDrag = null;
    wireDrag = null;
    endpointDrag = null;
    freeDraw = null;
    panDrag = null;
    cancelPortDrag();
    clearOverlays();
  }

  // 松开 BUTTON：删除/替换状态后也安全；已为 0 时不重复提交。
  function releaseActiveButton(options) {
    const restored = restoredButtons;
    restoredButtons = new Set();
    if (!(options && options.discard)) {
      for (const id of restored) {
        const component = app.getState().components[id];
        if (component && component.type === 'BUTTON' && component.on) {
          app.commit(setButtonPressed(app.getState(), id, false), { history: false });
        }
      }
    }
    const active = activeButton;
    activeButton = null;
    if (!active) {
      return;
    }
    try {
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(active.pointerId)) {
        canvas.releasePointerCapture(active.pointerId);
      }
    } catch (err) {
      // 忽略。
    }
    if (options && options.discard) return;
    const state = app.getState();
    const component = state.components[active.id];
    if (!component || component.type !== 'BUTTON' || component.on === false) {
      app.render();
      return;
    }
    const result = setButtonPressed(state, active.id, false);
    if (app.commit(result, { history: false })) {
      app.render();
    }
  }

  function commitSelection(kind, id) {
    app.setSelection({ kind, id });
    app.render();
  }

  function cancelRubberFrame() {
    if (rubberFrame !== null) {
      window.cancelAnimationFrame(rubberFrame);
      rubberFrame = null;
    }
  }

  function updateRubber(screen) {
    if (!armed) {
      return;
    }
    const state = app.getState();
    const view = app.getView();
    const cursor = screenToWorld(screen, view);
    const target = resolveAnchor(state, view, cursor, { definitions: app.getDefinitions() });
    let rubber;
    if (target) {
      const preview = previewConnect(state, armed.start, target, { definitions: app.getDefinitions() });
      if (preview.ok) {
        rubber = { points: preview.points, status: 'valid' };
      } else {
        rubber = { points: rubberPoints(armed.start.point, target.point), status: 'invalid' };
      }
      hoverKey = target.point.x + ',' + target.point.y;
      app.overlay.hoverAnchor = { x: target.point.x, y: target.point.y };
      setPinHover(target.kind === 'pin' ? target : null, screen);
    } else {
      // 从管脚/线身拖向空白处：按真实布线结果预览，松手后创建悬空线。
      const freePoint = snapToWireGridPoint(cursor);
      const preview = previewCreateAnchoredFreeWire(state, armed.start, freePoint, { definitions: app.getDefinitions() });
      rubber = preview.ok
        ? { points: preview.points, status: 'valid' }
        : { points: rubberPoints(armed.start.point, cursor), status: 'free' };
      hoverKey = '';
      app.overlay.hoverAnchor = null;
      setPinHover(null, screen);
    }
    app.overlay.rubber = rubber;
    app.render();
  }

  function requestRubber(screen) {
    lastScreen = screen;
    if (rubberFrame !== null) {
      return;
    }
    rubberFrame = window.requestAnimationFrame(function () {
      rubberFrame = null;
      if (!armed) {
        return;
      }
      updateRubber(lastScreen);
    });
  }

  function disarm() {
    armed = null;
    lastScreen = null;
    cancelRubberFrame();
    app.overlay.preview = null;
    app.overlay.wireStart = null;
    app.overlay.rubber = null;
    app.overlay.hoverAnchor = null;
    hoverKey = '';
  }

  function beginArm(screen, anchor, pointerId) {
    armed = {
      start: anchor,
      downScreen: { x: screen.x, y: screen.y },
      pointerId
    };
    lastScreen = screen;
    app.overlay.preview = null;
    app.overlay.wireStart = { x: anchor.point.x, y: anchor.point.y };
    app.overlay.rubber = null;
    app.overlay.hoverAnchor = { x: anchor.point.x, y: anchor.point.y };
    hoverKey = anchor.point.x + ',' + anchor.point.y;
    app.render();
  }

  function commitConnect(start, end, keepActive) {
    const result = connect(app.getState(), start, end, { definitions: app.getDefinitions() });
    // 结构合法不等于运行策略接受（反馈环 A 校验在 commit 内），
    // 只有真正提交成功后才更新选择/模式，避免指向不存在的线。
    if (app.commit(result)) {
      app.setSelection({ kind: 'wire', id: result.id });
      // 默认创建一条新线后回到选择模式；按住 Ctrl/Cmd 时保持线工具激活。
      if (!keepActive) {
        app.setMode('select');
      }
    }
  }

  function snapToWireGridPoint(point) {
    return { x: snapToWireGrid(point.x), y: snapToWireGrid(point.y) };
  }

  function commitAnchoredFreeWire(start, screen, keepActive) {
    const world = screenToWorld(screen, app.getView());
    const point = snapToWireGridPoint(world);
    const result = createAnchoredFreeWire(app.getState(), start, point, {
      definitions: app.getDefinitions()
    });
    if (app.commit(result)) {
      app.setSelection({ kind: 'wire', id: result.id });
      if (!keepActive) {
        app.setMode('select');
      }
    }
    app.render();
  }

  function handleWirePointerDown(event, screen) {
    const state = app.getState();
    const view = app.getView();
    const world = screenToWorld(screen, view);

    if (armed) {
      const anchor = resolveAnchor(state, view, world, { definitions: app.getDefinitions() });
      const start = armed.start;
      const keepActive = isKeepActive(event);
      disarm();
      if (!anchor) {
        commitAnchoredFreeWire(start, screen, keepActive);
        return;
      }
      commitConnect(start, anchor, keepActive);
      return;
    }

    const anchor = resolveAnchor(state, view, world, { definitions: app.getDefinitions() });
    if (!anchor) {
      freeDraw = {
        start: { x: snapToWireGrid(world.x), y: snapToWireGrid(world.y) },
        startScreen: { x: screen.x, y: screen.y },
        moved: false,
        signature: null
      };
      app.overlay.rubber = null;
      app.overlay.wireStart = { x: freeDraw.start.x, y: freeDraw.start.y };
      app.overlay.hoverAnchor = null;
      hoverKey = '';
      app.render();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        // 某些环境不支持 pointer capture，忽略即可。
      }
      return;
    }
    if (anchor.kind === 'pin' && isPinConnected(state, anchor.componentId, anchor.pinId)) {
      toast.show(REASONS.PIN_ALREADY_CONNECTED);
      setHover(null);
      return;
    }

    beginArm(screen, anchor, event.pointerId);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (err) {
      // 某些环境不支持 pointer capture，忽略即可。
    }
  }

  function finishArmedPointer(event) {
    if (!armed) {
      return;
    }
    const screen = eventScreenPoint(event, canvas);
    if (armed.pointerId !== null && event.pointerId !== armed.pointerId) {
      return;
    }
    const moved = Math.hypot(
      screen.x - armed.downScreen.x,
      screen.y - armed.downScreen.y
    );
    if (moved <= 3) {
      if (app.getMode() === 'select') {
        disarm();
        app.render();
      }
      return;
    }

    const state = app.getState();
    const view = app.getView();
    const end = resolveAnchor(state, view, screenToWorld(screen, view), { definitions: app.getDefinitions() });
    const start = armed.start;
    const keepActive = isKeepActive(event);
    disarm();
    if (!end) {
      // 松手在空白处：保留起点拓扑锚点，创建一条 free 端的悬空线。
      commitAnchoredFreeWire(start, screen, keepActive);
      return;
    }
    commitConnect(start, end, keepActive);
  }

  function freeDrawTarget(state, start, screen, definitions) {
    const view = app.getView();
    const world = screenToWorld(screen, view);
    const end = nearestFreeEnd(state, view, world);
    const body = nearestWirePoint(state, view, world);
    if (end || body) {
      const pin = nearestPin(state, view, world, { definitions });
      const hit = end && (!body || end.dist <= body.dist) ? end : body;
      if (!pin || hit.dist < pin.dist) {
        if (hit === end) {
          return { kind: 'end', point: end.point, wireId: end.wireId, side: end.side };
        }
        return { kind: 'junction', point: body.anchor.point, wireId: body.anchor.wireId, anchor: body.anchor };
      }
    }
    return { kind: 'free', point: freeLineEnd(start, world) };
  }

  function freeDrawCommand(state, start, target, definitions, preview) {
    if (target.kind === 'end') {
      const command = preview ? previewExtendFreeWire : extendFreeWire;
      return command(state, target.wireId, target.side, start, { definitions });
    }
    if (target.kind === 'junction') {
      const command = preview ? previewCreateAnchoredFreeWire : createAnchoredFreeWire;
      return command(state, target.anchor, start, { definitions });
    }
    const command = preview ? previewCreateFreeWire : createFreeWire;
    return command(state, start, target.point, { definitions });
  }

  function updateFreeDraw(screen) {
    if (!freeDraw) {
      return;
    }
    const dx = screen.x - freeDraw.startScreen.x;
    const dy = screen.y - freeDraw.startScreen.y;
    if (!freeDraw.moved && Math.hypot(dx, dy) < 3) {
      return;
    }
    freeDraw.moved = true;

    const state = app.getState();
    const definitions = app.getDefinitions();
    const target = freeDrawTarget(state, freeDraw.start, screen, definitions);
    const signature = [target.kind, target.wireId, target.side, target.point.x, target.point.y].join(':');
    if (signature === freeDraw.signature) {
      return;
    }
    freeDraw.signature = signature;

    const result = freeDrawCommand(state, freeDraw.start, target, definitions, true);
    // 锚定悬空线按宿主→空白返回，画线预览按用户的拖动方向显示。
    const points = result.ok
      ? (target.kind === 'junction' ? result.points.slice().reverse() : result.points)
      : rubberPoints(freeDraw.start, target.point);
    app.overlay.rubber = {
      points,
      status: result.ok ? 'valid' : 'invalid'
    };
    setHover(target.kind === 'free' ? null : target.point);
    app.render();
  }

  function finishFreeDraw(event) {
    const draw = freeDraw;
    freeDraw = null;
    app.overlay.rubber = null;
    app.overlay.wireStart = null;
    setHover(null);
    if (!draw) {
      app.render();
      return;
    }
    const screen = eventScreenPoint(event, canvas);
    if (!draw.moved && Math.hypot(screen.x - draw.startScreen.x, screen.y - draw.startScreen.y) < 3) {
      app.render();
      return;
    }
    const state = app.getState();
    const definitions = app.getDefinitions();
    const target = freeDrawTarget(state, draw.start, screen, definitions);
    if (target.point.x === draw.start.x && target.point.y === draw.start.y) {
      app.render();
      return;
    }
    const result = freeDrawCommand(state, draw.start, target, definitions, false);
    if (app.commit(result)) {
      app.setSelection({ kind: 'wire', id: result.id });
      // 默认创建一条新线后回到选择模式；按住 Ctrl/Cmd 时保持线工具激活。
      if (!isKeepActive(event)) {
        app.setMode('select');
      }
    }
    app.render();
  }

  function translatePoints(points, dx, dy) {
    return (points || []).map(function (point) {
      return { x: point.x + dx, y: point.y + dy };
    });
  }

  function startGroupDrag(selection, screen) {
    if (app.isReadOnlyDraft()) return;
    groupDrag = {
      selection: {
        components: (selection.components || []).slice(),
        wires: (selection.wires || []).slice(),
        frames: (selection.frames || []).slice()
      },
      startScreen: { x: screen.x, y: screen.y },
      startWorld: screenToWorld(screen, app.getView()),
      hasComponents: (selection.components || []).length > 0 ||
        (selection.frames || []).length > 0,
      dx: 0,
      dy: 0,
      moved: false
    };
    app.overlay.hoverAnchor = null;
    hoverKey = '';
  }

  function updateGroupDrag(screen) {
    if (!groupDrag) {
      return;
    }
    const dxs = screen.x - groupDrag.startScreen.x;
    const dys = screen.y - groupDrag.startScreen.y;
    if (!groupDrag.moved && Math.hypot(dxs, dys) < 4) {
      return;
    }
    groupDrag.moved = true;
    const world = screenToWorld(screen, app.getView());
    const rawDx = world.x - groupDrag.startWorld.x;
    const rawDy = world.y - groupDrag.startWorld.y;
    let dx;
    let dy;
    if (groupDrag.hasComponents) {
      dx = Math.round(rawDx / CELL) * CELL;
      dy = Math.round(rawDy / CELL) * CELL;
    } else {
      dx = snapToWireGrid(rawDx);
      dy = snapToWireGrid(rawDy);
    }
    if (dx === groupDrag.dx && dy === groupDrag.dy) {
      return;
    }
    groupDrag.dx = dx;
    groupDrag.dy = dy;
    if (dx === 0 && dy === 0) {
      app.overlay.groupDrag = null;
      app.render();
      return;
    }

    const state = app.getState();
    const components = [];
    for (const id of groupDrag.selection.components) {
      const component = state.components[id];
      if (!component) {
        continue;
      }
      components.push({
        cx: component.cx + dx / CELL,
        cy: component.cy + dy / CELL,
        type: component.type,
        definitionId: component.definitionId,
        rotation: component.rotation || 0
      });
    }
    const wires = [];
    for (const id of groupDrag.selection.wires) {
      const wire = state.wires[id];
      if (!wire) {
        continue;
      }
      wires.push({ points: translatePoints(wire.points, dx, dy) });
    }
    const frames = [];
    for (const id of groupDrag.selection.frames) {
      const frame = state.frames[id];
      if (!frame) {
        continue;
      }
      frames.push(Object.assign({}, frame, {
        x: frame.x + dx,
        y: frame.y + dy
      }));
    }
    app.overlay.groupDrag = { components, wires, frames };
    app.render();
  }

  function finishGroupDrag(event) {
    const drag = groupDrag;
    groupDrag = null;
    app.overlay.groupDrag = null;
    if (!drag || !drag.moved || (drag.dx === 0 && drag.dy === 0)) {
      app.render();
      return;
    }
    const result = moveSelectionCommand(
      app.getState(),
      drag.selection.components,
      drag.selection.wires,
      drag.dx,
      drag.dy,
      drag.selection.frames
    , { definitions: app.getDefinitions() });
    app.commit(result);
    app.render();
  }

  function buildCopySnapshot(selection) {
    const state = app.getState();
    const { components: componentIds, wires: wireIds, frames: frameIds } = selectionObjects(selection);
    const components = [];
    for (const id of componentIds) {
      const component = state.components[id];
      if (!component) {
        continue;
      }
      components.push({
        id,
        type: component.type,
        definitionId: component.definitionId,
        cx: component.cx,
        cy: component.cy,
        rotation: component.rotation || 0,
        on: component.on,
        period: component.period
      });
    }
    const wires = [];
    for (const id of wireIds) {
      const wire = state.wires[id];
      if (!wire) {
        continue;
      }
      wires.push({
        id,
        points: (wire.points || []).map(function (point) {
          return { x: point.x, y: point.y };
        }),
        endA: wire.endA ? JSON.parse(JSON.stringify(wire.endA)) : null,
        endB: wire.endB ? JSON.parse(JSON.stringify(wire.endB)) : null
      });
    }
    const frames = [];
    for (const id of frameIds) {
      const frame = state.frames[id];
      if (!frame) {
        continue;
      }
      frames.push({
        id,
        x: frame.x,
        y: frame.y,
        w: frame.w,
        h: frame.h,
        color: frame.color,
        label: frame.label
      });
    }
    return { components, wires, frames };
  }

  function snapshotHasObjects(snapshot) {
    return Boolean(snapshot) &&
      (snapshot.components.length + snapshot.wires.length + snapshot.frames.length) > 0;
  }

  function captureCopySnapshot(selection) {
    if (app.isReadOnlyDraft()) {
      return null;
    }
    const snapshot = buildCopySnapshot(selection);
    return snapshotHasObjects(snapshot) ? snapshot : null;
  }

  function resetCopySession() {
    beginCopySession('idle');
  }

  function cancelPendingCopy() {
    if (copySession.phase === 'pending') resetCopySession();
  }

  function beginCopySession(phase, details = {}) {
    if (copySession.previewFrame !== undefined) {
      window.cancelAnimationFrame(copySession.previewFrame);
    }
    copySession = { phase, ...details };
    app.overlay.copyGhost = null;
  }

  function activateCopyTool(phase, details) {
    beginCopySession(phase, details);
    menu.close();
    app.tool = 'COPY';
    app.setMode('copy');
    app.render();
  }

  function startCopyWithSnapshot(snapshot) {
    if (app.isReadOnlyDraft() || !snapshotHasObjects(snapshot)) {
      return false;
    }
    cancelInputGestures();
    activateCopyTool('placing', { snapshot });
    return true;
  }

  function startCopy(selection, dragPointerId) {
    if (app.isReadOnlyDraft()) return;
    cancelInputGestures();
    const snapshot = buildCopySnapshot(selection);
    if (snapshotHasObjects(snapshot)) {
      activateCopyTool('placing', { snapshot, dragPointerId });
    }
  }

  // Ctrl/Cmd+拖动：达到阈值后复用复制预览，由发起拖动的指针在松手时放置。
  function canStartCtrlCopy(state, selection, target) {
    return !app.isReadOnlyDraft() &&
      selection &&
      selectionContains(selection, target) &&
      canCopySelection(state, selection);
  }

  function beginCtrlCopyDrag(selection, target, screen, event) {
    const objects = selectionObjects(selection);
    beginCopySession('pending', {
      selection: {
        kind: 'multi',
        components: objects.components,
        wires: objects.wires,
        frames: objects.frames
      },
      start: { x: screen.x, y: screen.y },
      target,
      pointerId: event.pointerId
    });
    app.overlay.hoverAnchor = null;
    hoverKey = '';
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (err) {
      // 忽略。
    }
  }

  function ctrlCopyPointerId() {
    return copySession.phase === 'pending' ? copySession.pointerId : copySession.dragPointerId;
  }

  function startCopyDragIfMoved(screen) {
    const drag = copySession;
    if (Math.hypot(screen.x - drag.start.x, screen.y - drag.start.y) < 4) return false;
    resetCopySession();
    startCopy(drag.selection, drag.pointerId);
    return true;
  }

  function finishCtrlCopyDrag(screen) {
    if (copySession.phase === 'pending') {
      const { target } = copySession;
      if (!startCopyDragIfMoved(screen)) {
        resetCopySession();
        app.setSelection(toggleSelectionObject(app.getSelection(), target));
        app.render();
        return;
      }
    }
    if (app.getMode() !== 'copy' || app.isReadOnlyDraft()) {
      cancelCopy();
      return;
    }
    copySession.dragPointerId = undefined;
    placeCopyAt(screen);
    // 非法落点保留普通复制状态，预览以松手位置为准，可单击重试。
    if (copySession.phase === 'placing') requestCopyPreview(screen);
  }

  function cancelCtrlCopyDrag(pointerId) {
    const activePointerId = ctrlCopyPointerId();
    if (activePointerId === undefined || (pointerId !== undefined && pointerId !== activePointerId)) return;
    if (copySession.phase === 'pending') resetCopySession();
    else cancelCopy();
  }

  function copyAnchor(screen) {
    const world = screenToWorld(screen, app.getView());
    return copyAnchorAt(copySession.snapshot, world);
  }

  function updateCopyAt(screen) {
    const { cx, cy } = copyAnchor(screen);
    const state = app.getState();
    const definitions = app.getDefinitions();
    const previous = copySession.previewed;
    if (previous && previous.cx === cx && previous.cy === cy &&
        previous.state === state && previous.definitions === definitions) {
      return;
    }
    const preview = previewCopySelection(state, copySession.snapshot, cx, cy, { definitions });
    copySession.previewed = { cx, cy, state, definitions };
    app.overlay.copyGhost = {
      components: (preview.components || []).map(function (target) {
        return {
          cx: target.cx,
          cy: target.cy,
          type: target.type,
          definitionId: target.definitionId,
          rotation: target.rotation || 0
        };
      }),
      wires: preview.wires || [],
      frames: preview.frames || [],
      status: preview.ok ? 'valid' : 'invalid'
    };
    app.render();
  }

  function requestCopyPreview(screen) {
    const session = copySession;
    session.previewScreen = screen;
    if (session.previewFrame !== undefined) {
      return;
    }
    session.previewFrame = window.requestAnimationFrame(function () {
      session.previewFrame = undefined;
      if (session !== copySession) {
        return;
      }
      if (app.getMode() !== 'copy') {
        resetCopySession();
        app.render();
        return;
      }
      updateCopyAt(session.previewScreen);
    });
  }

  function clearCopyInteraction() {
    const pickingBox = marquee?.mode === 'copy';
    const redraw = Boolean(app.overlay.copyGhost || (pickingBox && app.overlay.marquee));
    resetCopySession();
    if (pickingBox) {
      marquee = null;
      app.overlay.marquee = null;
    }
    return redraw;
  }

  function cancelCopyForModeChange(nextMode) {
    const mode = app.getMode();
    if (nextMode === mode || copySession.phase === 'idle') return false;
    if (copySession.phase === 'pending' || mode === 'copy') return clearCopyInteraction();
    return false;
  }

  function cancelCopy() {
    clearCopyInteraction();
    if (app.getMode() === 'copy') {
      app.setMode('select');
    }
    app.render();
  }

  function toggleCopyTool() {
    if (app.isReadOnlyDraft()) return;
    if (app.getMode() === 'copy') {
      cancelCopy();
      return;
    }
    const selection = app.getSelection();
    if (canCopySelection(app.getState(), selection)) {
      startCopy(selection);
      return;
    }
    cancelInputGestures();
    activateCopyTool('picking');
  }

  function handleCopyPick(screen, event) {
    const state = app.getState();
    const view = app.getView();
    const world = screenToWorld(screen, view);
    const componentId = hitComponent(state, world, { definitions: app.getDefinitions() });
    if (componentId) {
      app.setSelection({ kind: 'component', id: componentId });
      startCopy(app.getSelection());
      return;
    }
    const wireHit = hitWire(state, view, screen);
    if (wireHit) {
      app.setSelection({ kind: 'wire', id: wireHit.id });
      startCopy(app.getSelection());
      return;
    }
    const frameId = hitFrame(state, view, screen, true);
    if (frameId) {
      app.setSelection({ kind: 'frame', id: frameId });
      startCopy(app.getSelection());
      return;
    }
    startMarquee(screen, 'copy');
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (err) {
      // 忽略。
    }
  }

  function placeCopyAt(screen) {
    if (copySession.phase !== 'placing') {
      return;
    }
    const anchor = copyAnchor(screen);
    const result = copySelectionCommand(
      app.getState(),
      copySession.snapshot,
      anchor.cx,
      anchor.cy
    , { definitions: app.getDefinitions() });
    if (!result.ok) {
      app.commit(result);
      app.render();
      return;
    }
    if (!app.commit(result)) {
      app.render();
      return;
    }
    app.setSelection(selectionFromObjects(result.componentIds, result.wireIds, result.frameIds));
    resetCopySession();
    app.setMode('select');
    app.render();
  }

  function snapFramePoint(screen) {
    const world = screenToWorld(screen, app.getView());
    return {
      x: Math.round(world.x / CELL) * CELL,
      y: Math.round(world.y / CELL) * CELL
    };
  }

  function startFrameDraw(screen) {
    if (app.isReadOnlyDraft()) return;
    const point = snapFramePoint(screen);
    frameDraw = {
      start: point,
      startScreen: { x: screen.x, y: screen.y },
      current: point,
      moved: false
    };
    app.overlay.frameDraw = null;
    app.render();
  }

  function updateFrameDraw(screen) {
    if (!frameDraw) {
      return;
    }
    const current = snapFramePoint(screen);
    if (!frameDraw.moved) {
      const dx = screen.x - frameDraw.startScreen.x;
      const dy = screen.y - frameDraw.startScreen.y;
      if (Math.hypot(dx, dy) < 3) {
        return;
      }
    }
    frameDraw.current = current;
    frameDraw.moved = true;
    app.overlay.frameDraw = normalizeFrameRect(frameDraw.start, current);
    app.render();
  }

  function finishFrameDraw(event) {
    const draw = frameDraw;
    frameDraw = null;
    app.overlay.frameDraw = null;
    if (!draw || !draw.moved) {
      app.render();
      return;
    }
    const rect = normalizeFrameRect(draw.start, draw.current);
    if (rect.w < CELL || rect.h < CELL) {
      app.render();
      return;
    }
    const result = addFrameCommand(app.getState(), rect, {
      color: FRAME_DEFAULT_COLOR,
      label: FRAME_DEFAULT_LABEL
    });
    if (app.commit(result)) {
      app.setSelection({ kind: 'frame', id: result.id });
      // 默认创建分组框后回到选择模式；按住 Ctrl/Cmd 时保持画框工具激活。
      if (!isKeepActive(event)) {
        app.setMode('select');
      }
    }
    app.render();
  }

  function startFrameDrag(frameId, screen) {
    if (app.isReadOnlyDraft()) return;
    const frame = app.getState().frames[frameId];
    if (!frame) {
      return;
    }
    frameDrag = {
      id: frameId,
      startScreen: { x: screen.x, y: screen.y },
      startX: frame.x,
      startY: frame.y,
      dx: 0,
      dy: 0,
      moved: false
    };
    app.overlay.frameDrag = null;
  }

  function updateFrameDrag(screen) {
    if (!frameDrag) {
      return;
    }
    const dxScreen = screen.x - frameDrag.startScreen.x;
    const dyScreen = screen.y - frameDrag.startScreen.y;
    if (!frameDrag.moved && Math.hypot(dxScreen, dyScreen) < 3) {
      return;
    }
    const view = app.getView();
    const startWorld = screenToWorld(frameDrag.startScreen, view);
    const currentWorld = screenToWorld(screen, view);
    const dx = Math.round((currentWorld.x - startWorld.x) / CELL) * CELL;
    const dy = Math.round((currentWorld.y - startWorld.y) / CELL) * CELL;
    const frame = app.getState().frames[frameDrag.id];
    if (!frame) {
      return;
    }
    frameDrag.moved = true;
    frameDrag.dx = dx;
    frameDrag.dy = dy;
    app.overlay.frameDrag = Object.assign({}, frame, {
      x: frameDrag.startX + dx,
      y: frameDrag.startY + dy
    });
    app.render();
  }

  function finishFrameDrag() {
    const drag = frameDrag;
    frameDrag = null;
    app.overlay.frameDrag = null;
    if (!drag || !drag.moved || (drag.dx === 0 && drag.dy === 0)) {
      app.render();
      return;
    }
    const result = moveFrameCommand(app.getState(), drag.id, drag.dx, drag.dy);
    if (app.commit(result)) {
      app.setSelection({ kind: 'frame', id: drag.id });
    }
    app.render();
  }

  function openFrameForm(frameId) {
    if (!frameForm) {
      return;
    }
    const frame = app.getState().frames[frameId];
    if (!frame) {
      return;
    }
    frameForm.open({
      color: frame.color || FRAME_DEFAULT_COLOR,
      label: frame.label || FRAME_DEFAULT_LABEL,
      onSave: function (values) {
        const result = updateFrameCommand(app.getState(), frameId, values);
        if (app.commit(result)) {
          app.setSelection({ kind: 'frame', id: frameId });
          app.render();
        }
      }
    });
  }

  function startMarquee(screen, mode, additive) {
    if (app.isReadOnlyDraft() && mode !== 'select') return;
    const nextMode = mode || 'select';
    const add = Boolean(additive) && nextMode === 'select';
    marquee = {
      start: { x: screen.x, y: screen.y },
      current: { x: screen.x, y: screen.y },
      moved: false,
      mode: nextMode,
      additive: add,
      baseSelection: app.getSelection()
    };
    app.overlay.marquee = null;
    if (!add && nextMode !== 'delete') {
      app.setSelection({ kind: null, id: null });
    }
    app.render();
  }

  function updateMarquee(screen) {
    if (!marquee) {
      return;
    }
    const dx = screen.x - marquee.start.x;
    const dy = screen.y - marquee.start.y;
    if (!marquee.moved && Math.hypot(dx, dy) < 3) {
      return;
    }
    marquee.moved = true;
    marquee.current = { x: screen.x, y: screen.y };
    app.overlay.marquee = {
      x1: marquee.start.x,
      y1: marquee.start.y,
      x2: screen.x,
      y2: screen.y,
      status: marquee.mode === 'delete'
        ? 'delete'
        : marquee.mode === 'copy'
          ? 'copy'
          : 'select'
    };
    app.render();
  }

  function finishMarquee(event) {
    const box = marquee;
    marquee = null;
    app.overlay.marquee = null;
    if (!box) {
      return;
    }
    if (!box.moved) {
      if (!box.additive) {
        app.setSelection({ kind: null, id: null });
      }
      app.render();
      return;
    }
    const rect = {
      x1: box.start.x,
      y1: box.start.y,
      x2: box.current.x,
      y2: box.current.y
    };
    const components = componentsInRect(app.getState(), app.getView(), rect, { definitions: app.getDefinitions() });
    const wires = wiresInRect(app.getState(), app.getView(), rect);
    const frames = framesInRect(app.getState(), app.getView(), rect);
    const total = components.length + wires.length + frames.length;
    if (box.mode === 'copy') {
      if (!box.moved || total === 0) {
        app.render();
        return;
      }
      const selection = selectionFromObjects(components, wires, frames);
      app.setSelection(selection);
      startCopy(selection);
      return;
    }
    if (box.mode === 'delete') {
      if (!box.moved || total === 0) {
        app.render();
        return;
      }
      const result = removeSelectionCommand(app.getState(), components, wires, frames);
      if (app.commit(result)) {
        app.setSelection({ kind: null, id: null });
        app.setMode('select');
      }
      app.render();
      return;
    }
    if (box.additive) {
      app.setSelection(unionSelection(box.baseSelection, components, wires, frames));
    } else {
      app.setSelection(selectionFromObjects(components, wires, frames));
    }
    app.render();
  }

  function startEndpointDrag(hit, screen, sourceKind = 'free') {
    endpointDrag = {
      wireId: hit.wireId,
      side: hit.side,
      startScreen: { x: screen.x, y: screen.y },
      moved: false,
      signature: null,
      sourceKind
    };
  }

  function otherEndPoint(state, wireId, side) {
    const wire = state.wires[wireId];
    if (!wire || !wire.points || wire.points.length < 2) {
      return null;
    }
    return side === 'A' ? wire.points[wire.points.length - 1] : wire.points[0];
  }

  // 每次按当前状态解析；预览只缓存显示签名，提交不复用旧命中结果。
  function endpointDragTarget(state, drag, screen) {
    const view = app.getView();
    const world = screenToWorld(screen, view);
    const detachPin = drag.sourceKind === 'pin';
    const detachJunction = drag.sourceKind === 'junction';
    const point = snapToWireGridPoint(world);
    if (!detachPin) {
      const hit = detachJunction
        ? nearestFreeEnd(state, view, point, { excludeWireId: drag.wireId })
        : nearestJunctionEnd(state, view, point);
      if (hit && hit.point.x === point.x && hit.point.y === point.y) {
        const branchHit = detachJunction ? drag : hit;
        const hostHit = detachJunction ? hit : drag;
        const branch = state.wires[branchHit.wireId];
        const end = branchHit.side === 'A' ? branch?.endA : branch?.endB;
        if (end?.kind === 'junction' && end.wireId === hostHit.wireId) {
          return {
            kind: 'collapse-t', point, hover: point, pinAnchor: null,
            signature: 'collapse-t:' + hit.wireId + ':' + hit.side,
            args: [point]
          };
        }
      }
    }
    const pinHit = detachJunction ? null : nearestPin(state, view, world, { definitions: app.getDefinitions() });
    const freeHit = drag.sourceKind === 'free'
      ? nearestFreeEnd(state, view, world, { excludeWireId: drag.wireId })
      : null;
    // 只有悬空端拖动可以直接和另一悬空端合并。
    if (freeHit) {
      return {
        kind: 'merge', point: freeHit.point, hover: freeHit.point, pinAnchor: null,
        signature: 'freeend:' + freeHit.wireId + ':' + freeHit.side,
        args: [freeHit.wireId, freeHit.side]
      };
    }
    if (pinHit) {
      const anchor = pinHit.anchor;
      const kind = pinHit.connected ? 'used' : 'pin';
      return {
        kind, point: anchor.point, hover: anchor.point, pinAnchor: anchor,
        signature: (detachPin ? 'detach' : '') + kind + ':' + anchor.componentId + ':' + anchor.pinId,
        args: detachPin
          ? [anchor.point, { kind: 'pin', componentId: anchor.componentId, pinId: anchor.pinId }]
          : [anchor]
      };
    }
    if (!detachPin) {
      // 排除正在拖动的线，避免其旧线身遮蔽目标宿主。
      const wires = Object.assign({}, state.wires);
      delete wires[drag.wireId];
      const wireHit = nearestWirePoint({ ...state, wires }, view, world);
      const anchor = wireHit?.anchor;
      // 已连接的 T 端只吸附实际落下的网格点，邻近空白点仍可断接。
      if (anchor && (!detachJunction || (anchor.point.x === point.x && anchor.point.y === point.y))) {
        return {
          kind: 'junction', point: anchor.point, hover: anchor.point, pinAnchor: null,
          signature: 'junction:' + anchor.wireId + ':' + anchor.point.x + ',' + anchor.point.y,
          args: [anchor]
        };
      }
    }
    return {
      kind: 'free', point, hover: null, pinAnchor: null,
      signature: (detachPin ? 'detachfree:' : 'free:') + point.x + ',' + point.y,
      args: detachPin ? [point, null] : [point]
    };
  }

  function endpointDragCommand(state, drag, target, preview) {
    let command;
    if (drag.sourceKind === 'junction') {
      if (target.kind === 'junction') {
        command = preview ? previewReconnectJunctionEnd : reconnectJunctionEnd;
      } else {
        command = preview ? previewDetachJunctionEnd : detachJunctionEnd;
      }
    } else if (drag.sourceKind === 'pin') {
      command = preview ? previewDetachPinEnd : detachPinEnd;
    } else if (target.kind === 'collapse-t') {
      command = preview ? previewMoveFreeEnd : moveFreeEnd;
    } else if (target.kind === 'merge') {
      command = preview ? previewMergeFreeEnds : mergeFreeEnds;
    } else if (target.kind === 'pin' || target.kind === 'junction') {
      command = preview ? previewAttachFreeEnd : attachFreeEnd;
    } else {
      // free→空白的预览保留橡皮筋，只在提交时执行移动命令。
      command = moveFreeEnd;
    }
    return command(state, drag.wireId, drag.side, ...target.args, { definitions: app.getDefinitions() });
  }

  function updateEndpointDrag(screen) {
    if (!endpointDrag) return;
    const dx = screen.x - endpointDrag.startScreen.x;
    const dy = screen.y - endpointDrag.startScreen.y;
    if (!endpointDrag.moved && Math.hypot(dx, dy) < 3) return;
    endpointDrag.moved = true;

    const state = app.getState();
    const target = endpointDragTarget(state, endpointDrag, screen);
    if (target.signature === endpointDrag.signature) return;
    endpointDrag.signature = target.signature;
    const fixed = otherEndPoint(state, endpointDrag.wireId, endpointDrag.side);
    let overlay = null;
    if (target.kind !== 'used') {
      const points = fixed ? rubberPoints(fixed, target.point) : null;
      if (endpointDrag.sourceKind === 'free' && target.kind === 'free') {
        overlay = fixed ? { points, status: 'free' } : null;
      } else {
        const preview = endpointDragCommand(state, endpointDrag, target, true);
        overlay = preview.ok
          ? { points: preview.points, status: 'valid' }
          : (fixed || target.kind !== 'free' ? { points, status: 'invalid' } : null);
      }
    }
    app.overlay.endpointDrag = overlay;
    app.overlay.hoverAnchor = target.hover;
    setPinHover(target.pinAnchor, screen);
    app.render();
  }

  function finishEndpointDrag(event) {
    const drag = endpointDrag;
    endpointDrag = null;
    app.overlay.endpointDrag = null;
    app.overlay.hoverAnchor = null;
    if (!drag || !drag.moved) {
      app.render();
      return;
    }

    const state = app.getState();
    const target = endpointDragTarget(state, drag, eventScreenPoint(event, canvas));
    const wire = state.wires[drag.wireId];
    const source = drag.side === 'A' ? wire?.endA : wire?.endB;
    if (source?.kind === 'junction' && target.point.x === source.point.x && target.point.y === source.point.y) {
      app.render();
      return;
    }
    if (target.kind === 'used') {
      const returnedToSource = drag.sourceKind === 'pin' && source?.kind === 'pin' &&
        source.componentId === target.pinAnchor.componentId && source.pinId === target.pinAnchor.pinId;
      if (!returnedToSource) app.commit({ ok: false, reason: REASONS.PIN_ALREADY_CONNECTED });
    } else {
      const result = endpointDragCommand(state, drag, target, false);
      if (app.commit(result)) {
        const id = target.kind === 'merge' ? result.id : drag.wireId;
        app.setSelection({ kind: 'wire', id });
      }
    }
    app.render();
  }

  function startWireDrag(hit, screen) {
    if (app.isReadOnlyDraft()) return;
    wireDrag = {
      wireId: hit.id,
      index: hit.index,
      startScreen: { x: screen.x, y: screen.y },
      startWorld: screenToWorld(screen, app.getView()),
      moved: false,
      signature: null
    };
  }

  // 只取垂直于线段的分量，预览宿主和随线移动的支线。
  function updateWireDrag(screen) {
    if (!wireDrag) {
      return;
    }
    const dx = screen.x - wireDrag.startScreen.x;
    const dy = screen.y - wireDrag.startScreen.y;
    if (!wireDrag.moved && Math.hypot(dx, dy) < 4) {
      return;
    }
    wireDrag.moved = true;

    const world = screenToWorld(screen, app.getView());
    const offset = {
      x: world.x - wireDrag.startWorld.x,
      y: world.y - wireDrag.startWorld.y
    };
    const result = previewDragWireSegment(
      app.getState(),
      wireDrag.wireId,
      wireDrag.index,
      offset
    , { definitions: app.getDefinitions() });
    const preview = result.points && (!result.ok || result.delta !== 0)
      ? { points: result.points, branches: result.branches, status: result.ok ? 'valid' : 'invalid' }
      : null;
    const signature = JSON.stringify(preview);
    if (signature === wireDrag.signature) {
      return;
    }
    wireDrag.signature = signature;

    app.overlay.wireDrag = preview;
    app.render();
  }

  function finishWireDrag(event) {
    const drag = wireDrag;
    wireDrag = null;
    app.overlay.wireDrag = null;
    if (!drag || !drag.moved) {
      app.render();
      return;
    }
    const world = screenToWorld(eventScreenPoint(event, canvas), app.getView());
    const offset = {
      x: world.x - drag.startWorld.x,
      y: world.y - drag.startWorld.y
    };
    const result = dragWireSegment(app.getState(), drag.wireId, drag.index, offset, { definitions: app.getDefinitions() });
    if (app.commit(result)) {
      app.setSelection({ kind: 'wire', id: drag.wireId });
    }
    app.render();
  }

  function startComponentDrag(componentId, screen) {
    if (app.isReadOnlyDraft()) return;
    const state = app.getState();
    const component = state.components[componentId];
    if (!component) {
      return;
    }
    const world = screenToWorld(screen, app.getView());
    const bounds = componentBounds(component, app.getDefinitions());
    componentDrag = {
      id: componentId,
      startScreen: screen,
      origin: { cx: component.cx, cy: component.cy },
      target: { cx: component.cx, cy: component.cy },
      grabOffset: { x: world.x - bounds.x, y: world.y - bounds.y },
      moved: false
    };
  }

  function updateComponentDrag(screen) {
    if (!componentDrag) {
      return;
    }
    const dx = screen.x - componentDrag.startScreen.x;
    const dy = screen.y - componentDrag.startScreen.y;
    if (!componentDrag.moved && Math.hypot(dx, dy) < 4) {
      return;
    }
    componentDrag.moved = true;
    const world = screenToWorld(screen, app.getView());
    const cx = Math.floor((world.x - componentDrag.grabOffset.x) / CELL);
    const cy = Math.floor((world.y - componentDrag.grabOffset.y) / CELL);
    if (cx !== componentDrag.target.cx || cy !== componentDrag.target.cy) {
      componentDrag.target = { cx, cy };
      const component = app.getState().components[componentDrag.id];
      app.overlay.dragGhost = {
        cx,
        cy,
        type: component.type,
        definitionId: component.definitionId,
        rotation: component.rotation || 0
      };
      app.render();
    }
  }

  function finishComponentDrag(event) {
    const drag = componentDrag;
    componentDrag = null;
    app.overlay.dragGhost = null;
    if (!drag) {
      return;
    }
    if (drag.moved) {
      const world = screenToWorld(eventScreenPoint(event, canvas), app.getView());
      const cx = Math.floor((world.x - drag.grabOffset.x) / CELL);
      const cy = Math.floor((world.y - drag.grabOffset.y) / CELL);
      if (cx !== drag.origin.cx || cy !== drag.origin.cy) {
        const result = moveComponent(app.getState(), drag.id, cx, cy, { definitions: app.getDefinitions() });
        if (app.commit(result)) {
          app.setSelection({ kind: 'component', id: drag.id });
        }
      }
    }
    app.render();
  }

  function deleteSelection() {
    if (app.isReadOnlyDraft()) return;
    const selection = app.getSelection();
    if (!selection || !selection.kind) {
      return;
    }
    const state = app.getState();
    let result;
    if (selection.kind === 'multi') {
      if (
        (!Array.isArray(selection.components) || selection.components.length === 0) &&
        (!Array.isArray(selection.wires) || selection.wires.length === 0) &&
        (!Array.isArray(selection.frames) || selection.frames.length === 0)
      ) {
        return;
      }
      result = removeSelectionCommand(
        state,
        selection.components,
        selection.wires,
        selection.frames
      );
    } else if (selection.kind === 'component' && selection.id) {
      result = removeComponentCommand(state, selection.id);
    } else if (selection.kind === 'wire' && selection.id) {
      result = deleteWire(state, selection.id);
    } else if (selection.kind === 'frame' && selection.id) {
      result = removeFrameCommand(state, selection.id);
    } else {
      return;
    }
    if (app.commit(result)) {
      app.setSelection({ kind: null, id: null });
      app.render();
    }
  }

  function handlePointerDown(event) {
    if (ctrlCopyPointerId() !== undefined) return;
    setComponentHover(null, eventScreenPoint(event, canvas));
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      event.preventDefault();
      const screen = eventScreenPoint(event, canvas);
      const view = app.getView();
      panDrag = {
        screen,
        pan: { x: view.pan.x, y: view.pan.y },
        pointerId: event.pointerId
      };
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        // 某些环境不支持 pointer capture，忽略即可。
      }
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const screen = eventScreenPoint(event, canvas);
    if (app.isReadOnlyDraft() && app.getMode() !== 'select') {
      app.setMode('select');
    }

    if (!app.isReadOnlyDraft() && app.getMode() === 'erase-port') {
      const portHit = app.hitPort ? app.hitPort(screen, true) : null;
      if (portHit && app.removePort) {
        app.removePort(portHit.id);
        app.render();
      } else {
        toast.show('请点击要移除的管脚标注');
      }
      return;
    }

    if (!app.isReadOnlyDraft() && app.getMode() === 'annotate') {
      const world = screenToWorld(screen, app.getView());
      const pick = nearestAnnotatable(app.getState(), app.getView(), world, { definitions: app.getDefinitions() });
      if (pick && app.onAnnotatePick) {
        app.onAnnotatePick(pick);
      } else {
        toast.show('请点击元件管脚或悬空导线端点');
      }
      return;
    }

    if (app.getMode() === 'copy') {
      if (copySession.phase === 'placing') {
        placeCopyAt(screen);
      } else {
        handleCopyPick(screen, event);
      }
      return;
    }

    if (app.getMode() === 'place') {
      const type = app.placeType || app.tool;
      if (!type || type === 'WIRE') {
        return;
      }
      const world = screenToWorld(screen, app.getView());
      const cx = Math.floor(world.x / CELL);
      const cy = Math.floor(world.y / CELL);
      const result = placeComponent(app.getState(), type, cx, cy, Object.assign({}, {
        definitionId: app.placeDefinitionId
      }, { definitions: app.getDefinitions() }));
      if (app.commit(result)) {
        app.setSelection({ kind: 'component', id: result.id });
        // Ctrl/Cmd 按住时保持 place 模式，便于连续放置同一类型。
        if (!(event.ctrlKey || event.metaKey)) {
          app.setMode('select');
        }
        app.render();
      }
      return;
    }

    if (app.getMode() === 'frame') {
      startFrameDraw(screen);
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        // 忽略。
      }
      return;
    }

    if (app.getMode() === 'wire') {
      handleWirePointerDown(event, screen);
      return;
    }

    if (app.getMode() === 'delete') {
      const state = app.getState();
      const view = app.getView();
      const world = screenToWorld(screen, view);
      const componentId = hitComponent(state, world, { definitions: app.getDefinitions() });
      if (componentId) {
        const result = removeComponentCommand(state, componentId);
        if (app.commit(result)) {
          app.setSelection({ kind: null, id: null });
          app.setMode('select');
          app.render();
        }
        return;
      }
      const wireHit = hitWire(state, view, screen);
      if (wireHit) {
        const result = deleteWire(state, wireHit.id);
        if (app.commit(result)) {
          app.setSelection({ kind: null, id: null });
          app.setMode('select');
          app.render();
        }
        return;
      }
      startMarquee(screen, 'delete');
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        // 忽略。
      }
      return;
    }

    const state = app.getState();
    const view = app.getView();
    const world = screenToWorld(screen, view);

    // Ctrl（macOS 用 Cmd）：切换对象是否加入选择；多选中的对象拖动则复用复制；
    // 空白处进入追加框选。
    if (event.ctrlKey || event.metaKey) {
      const tryBeginCtrlCopy = function (target) {
        const selection = app.getSelection();
        if (!canStartCtrlCopy(state, selection, target)) {
          return false;
        }
        beginCtrlCopyDrag(selection, target, screen, event);
        return true;
      };
      const componentId = hitComponent(state, world, { definitions: app.getDefinitions() });
      if (componentId) {
        const target = { kind: 'component', id: componentId };
        if (tryBeginCtrlCopy(target)) {
          return;
        }
        app.setSelection(toggleSelectionObject(app.getSelection(), target));
        app.render();
        return;
      }
      const wireHit = hitWire(state, view, screen);
      if (wireHit) {
        const target = { kind: 'wire', id: wireHit.id };
        if (tryBeginCtrlCopy(target)) {
          return;
        }
        app.setSelection(toggleSelectionObject(app.getSelection(), target));
        app.render();
        return;
      }
      const pinHit = nearestPin(state, view, world, { definitions: app.getDefinitions() });
      if (pinHit) {
        const target = { kind: 'component', id: pinHit.anchor.componentId };
        if (tryBeginCtrlCopy(target)) {
          return;
        }
        app.setSelection(toggleSelectionObject(app.getSelection(), target));
        app.render();
        return;
      }
      const frameId = hitFrame(state, view, screen);
      if (frameId) {
        const target = { kind: 'frame', id: frameId };
        if (tryBeginCtrlCopy(target)) {
          return;
        }
        app.setSelection(toggleSelectionObject(app.getSelection(), target));
        app.render();
        return;
      }
      startMarquee(screen, 'select', true);
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        // 忽略。
      }
      return;
    }

    const portHit = app.hitPort ? app.hitPort(screen) : null;
    if (portHit) {
      app.setSelection({ kind: 'port', id: portHit.id });
      if (!app.isReadOnlyDraft()) {
        portDrag = {
          portId: portHit.id,
          start: { x: screen.x, y: screen.y },
          moved: false,
          pointerId: event.pointerId
        };
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (err) {
          // 忽略。
        }
      }
      app.render();
      return;
    }

    // Toggle 中心开关是操作区：优先于引脚/导线命中，保证任意缩放下单击都能翻转。
    // BUTTON 同样是操作区：按住为 1，松开由 pointerup/cancel/blur 释放。
    const switchId = hitComponent(state, world, { definitions: app.getDefinitions() });
    const switchComponent = state.components[switchId];
    if (
      !app.isReadOnlyDraft() &&
      hitToggleSwitch(switchComponent, world, { definitions: app.getDefinitions() })
    ) {
      if (app.commit(toggleComponent(state, switchId))) {
        app.render();
        return;
      }
    }
    if (
      !app.isReadOnlyDraft() &&
      hitButtonSwitch(switchComponent, world, { definitions: app.getDefinitions() })
    ) {
      if (app.commit(setButtonPressed(state, switchId, true), { history: false })) {
        activeButton = { id: switchId, pointerId: event.pointerId };
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (err) {
          // 某些环境不支持 pointer capture，忽略即可。
        }
        app.render();
      }
      return;
    }

    // 先选端点所属导线；T 点属于支线，即使它落在宿主线身上。
    const freeEnd = nearestFreeEnd(state, view, world);
    const junctionEnd = nearestJunctionEnd(state, view, world);
    const end = junctionEnd && (!freeEnd || junctionEnd.dist <= freeEnd.dist) ? junctionEnd : freeEnd;
    if (end) {
      commitSelection('wire', end.wireId);
      if (!app.isReadOnlyDraft()) {
        startEndpointDrag(end, screen, end === junctionEnd ? 'junction' : 'free');
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (err) {
          // 忽略。
        }
      }
      return;
    }

    const pinHit = nearestPin(state, view, world, { definitions: app.getDefinitions() });
    if (pinHit) {
      if (pinHit.connected) {
        // 已接线管脚与线身都命中时，指针更靠近引脚才进入脱开流程；
        // 贴着引脚拖动线身仍保持原有“拖线段”手感。
        const wireBody = nearestWirePoint(state, view, world);
        if (!wireBody || pinHit.dist <= wireBody.dist) {
          const pinEnd = pinWireEnd(state, pinHit.anchor.componentId, pinHit.anchor.pinId);
          commitSelection('component', pinHit.anchor.componentId);
          if (pinEnd && !app.isReadOnlyDraft()) {
            startEndpointDrag(pinEnd, screen, 'pin');
            try {
              canvas.setPointerCapture(event.pointerId);
            } catch (err) {
              // 某些环境不支持 pointer capture，忽略即可。
            }
            return;
          }
          toast.show(REASONS.PIN_ALREADY_CONNECTED);
          return;
        }
      } else {
        const anchor = resolveAnchor(state, view, world, { definitions: app.getDefinitions() });
        if (anchor && anchor.kind === 'pin') {
          commitSelection('component', anchor.componentId);
          beginArm(screen, anchor, event.pointerId);
          try {
            canvas.setPointerCapture(event.pointerId);
          } catch (err) {
            // 某些环境不支持 pointer capture，忽略即可。
          }
          return;
        }
      }
    }

    const componentId = hitComponent(state, world, { definitions: app.getDefinitions() });
    if (componentId) {
      const selection = app.getSelection();
      if (
        !app.isReadOnlyDraft() &&
        selection &&
        selection.kind === 'multi' &&
        Array.isArray(selection.components) &&
        selection.components.indexOf(componentId) !== -1
      ) {
        startGroupDrag(selection, screen);
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (err) {
          // 忽略。
        }
        return;
      }
      commitSelection('component', componentId);
      if (!app.isReadOnlyDraft()) {
        startComponentDrag(componentId, screen);
      }
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        // 忽略。
      }
      return;
    }

    const wireHit = hitWire(state, app.getView(), screen);
    if (wireHit) {
      const selection = app.getSelection();
      if (
        !app.isReadOnlyDraft() &&
        selection &&
        selection.kind === 'multi' &&
        Array.isArray(selection.wires) &&
        selection.wires.indexOf(wireHit.id) !== -1
      ) {
        startGroupDrag(selection, screen);
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (err) {
          // 忽略。
        }
        return;
      }
      commitSelection('wire', wireHit.id);
      if (!app.isReadOnlyDraft()) {
        startWireDrag(wireHit, screen);
      }
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        // 忽略。
      }
      return;
    }

    const frameId = hitFrame(state, app.getView(), screen);
    if (frameId) {
      const selection = app.getSelection();
      if (
        !app.isReadOnlyDraft() &&
        selection &&
        selection.kind === 'multi' &&
        Array.isArray(selection.frames) &&
        selection.frames.indexOf(frameId) !== -1
      ) {
        startGroupDrag(selection, screen);
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (err) {
          // 忽略。
        }
        return;
      }
      app.setSelection({ kind: 'frame', id: frameId });
      if (!app.isReadOnlyDraft()) {
        startFrameDrag(frameId, screen);
      }
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch (err) {
        // 忽略。
      }
      app.render();
      return;
    }

    startMarquee(screen, 'select', event.ctrlKey || event.metaKey);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch (err) {
      // 忽略。
    }
  }

  function handlePointerMove(event) {
    const copyPointerId = ctrlCopyPointerId();
    if (copyPointerId !== undefined && event.pointerId !== copyPointerId) return;
    const screen = eventScreenPoint(event, canvas);
    if (copySession.phase === 'pending') {
      if (startCopyDragIfMoved(screen) && copySession.phase === 'placing') {
        requestCopyPreview(screen);
      }
      return;
    }
    const idle = !panDrag && copySession.phase !== 'placing' && !armed && !componentDrag &&
      !wireDrag && !endpointDrag && !freeDraw && !marquee &&
      !frameDraw && !frameDrag && !groupDrag && !portDrag;
    if (idle) {
      const state = app.getState();
      const view = app.getView();
      const world = screenToWorld(screen, view);
      const pinHit = nearestPin(state, view, world, { definitions: app.getDefinitions() });
      if (pinHit) {
        setComponentHover(null, screen);
        setPinHover(pinHit.anchor, screen);
      } else {
        setPinHover(null, screen);
        setComponentHover(hitComponent(state, world, { definitions: app.getDefinitions() }), screen);
      }
    } else if (!armed) {
      setPinHover(null, screen);
      setComponentHover(null, screen);
    }

    if (portDrag) {
      if (event.pointerId !== portDrag.pointerId) return;
      const dx = screen.x - portDrag.start.x;
      const dy = screen.y - portDrag.start.y;
      if (!portDrag.moved && Math.hypot(dx, dy) >= 4) {
        portDrag.moved = true;
      }
      if (portDrag.moved) {
        const target = app.previewPortTarget
          ? app.previewPortTarget(event.clientX, event.clientY, portDrag.portId)
          : null;
        app.setPortDrag(portDrag.portId, target);
      }
      return;
    }

    if (panDrag) {
      hoverPinKey = '';
      hoverComponentKey = '';
      const view = app.getView();
      app.setView({
        scale: view.scale,
        pan: {
          x: panDrag.pan.x + (screen.x - panDrag.screen.x),
          y: panDrag.pan.y + (screen.y - panDrag.screen.y)
        }
      });
      app.render();
      return;
    }

    if (copySession.phase === 'placing') {
      requestCopyPreview(screen);
      return;
    }

    if (armed) {
      requestRubber(screen);
      return;
    }

    if (componentDrag) {
      updateComponentDrag(screen);
      return;
    }

    if (wireDrag) {
      updateWireDrag(screen);
      return;
    }

    if (endpointDrag) {
      updateEndpointDrag(screen);
      return;
    }

    if (freeDraw) {
      updateFreeDraw(screen);
      return;
    }

    if (marquee) {
      updateMarquee(screen);
      return;
    }

    if (frameDraw) {
      updateFrameDraw(screen);
      return;
    }

    if (frameDrag) {
      updateFrameDrag(screen);
      return;
    }

    if (groupDrag) {
      updateGroupDrag(screen);
      return;
    }

    if (app.getMode() === 'wire') {
      const view = app.getView();
      const anchor = resolveAnchor(app.getState(), view, screenToWorld(screen, view), { definitions: app.getDefinitions() });
      setHover(anchor ? anchor.point : null);
    }
  }

  function releaseCapture(event) {
    try {
      if (canvas.hasPointerCapture && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    } catch (err) {
      // 忽略。
    }
  }

  function cancelPortDrag(pointerId) {
    if (!portDrag || (pointerId !== undefined && portDrag.pointerId !== pointerId)) return;
    const drag = portDrag;
    portDrag = null;
    app.setPortDrag(null);
    releaseCapture(drag);
  }

  function handlePointerUp(event) {
    if (activeButton) {
      releaseActiveButton();
      releaseCapture(event);
      return;
    }
    const copyPointerId = ctrlCopyPointerId();
    if (copyPointerId !== undefined) {
      if (event.pointerId !== copyPointerId) return;
      finishCtrlCopyDrag(eventScreenPoint(event, canvas));
      releaseCapture(event);
      return;
    }
    if (portDrag) {
      if (event.pointerId !== portDrag.pointerId) return;
      const drag = portDrag;
      portDrag = null;
      if (drag.moved) {
        app.dropPortAt(event.clientX, event.clientY, drag.portId);
      } else {
        app.setPortDrag(null);
      }
      releaseCapture(event);
      app.render();
      return;
    }
    if (panDrag) {
      panDrag = null;
      releaseCapture(event);
      return;
    }
    if (armed) {
      finishArmedPointer(event);
      releaseCapture(event);
      return;
    }
    if (componentDrag) {
      finishComponentDrag(event);
      releaseCapture(event);
      return;
    }
    if (wireDrag) {
      finishWireDrag(event);
      releaseCapture(event);
      return;
    }
    if (endpointDrag) {
      finishEndpointDrag(event);
      releaseCapture(event);
      return;
    }
    if (freeDraw) {
      finishFreeDraw(event);
      releaseCapture(event);
      return;
    }
    if (marquee) {
      finishMarquee(event);
      releaseCapture(event);
      return;
    }
    if (frameDraw) {
      finishFrameDraw(event);
      releaseCapture(event);
      return;
    }
    if (frameDrag) {
      finishFrameDrag();
      releaseCapture(event);
      return;
    }
    if (groupDrag) {
      finishGroupDrag(event);
      releaseCapture(event);
    }
  }

  function handlePointerCancel(event) {
    releaseActiveButton();
    cancelCtrlCopyDrag(event.pointerId);
    cancelPortDrag(event.pointerId);
    if (armed) {
      disarm();
    }
    if (componentDrag) {
      componentDrag = null;
      app.overlay.dragGhost = null;
    }
    if (wireDrag) {
      wireDrag = null;
      app.overlay.wireDrag = null;
    }
    if (endpointDrag) {
      endpointDrag = null;
      app.overlay.endpointDrag = null;
    }
    if (freeDraw) {
      freeDraw = null;
      app.overlay.rubber = null;
      app.overlay.wireStart = null;
      setHover(null);
    }
    if (marquee) {
      marquee = null;
      app.overlay.marquee = null;
    }
    if (groupDrag) {
      groupDrag = null;
      app.overlay.groupDrag = null;
    }
    if (frameDraw) {
      frameDraw = null;
      app.overlay.frameDraw = null;
    }
    if (frameDrag) {
      frameDrag = null;
      app.overlay.frameDrag = null;
    }
    if (panDrag) {
      panDrag = null;
    }
    releaseCapture(event);
    app.render();
  }

  function handleWheel(event) {
    event.preventDefault();
    const screen = eventScreenPoint(event, canvas);
    const factor = Math.exp(-event.deltaY * 0.0015);
    hoverPinKey = '';
    setComponentHover(null, screen);
    app.setView(zoomAt(app.getView(), screen, factor));
    app.render();
  }

  function handleDoubleClick(event) {
    const screen = eventScreenPoint(event, canvas);
    const portLabelHit = app.hitPortLabel ? app.hitPortLabel(screen) : null;
    if (portLabelHit) {
      event.preventDefault();
      void app.editPortLabel(portLabelHit.id);
      return;
    }
    const state = app.getState();
    const world = screenToWorld(screen, app.getView());
    const componentId = hitComponent(state, world, { definitions: app.getDefinitions() });
    if (!componentId) {
      return;
    }
    const component = state.components[componentId];
    if (!component) {
      return;
    }
    if (component.type === 'CUSTOM') {
      if (!component.definitionId) {
        toast.show('定义数据不完整，无法打开');
        return;
      }
      app.setSelection({ kind: 'component', id: componentId });
      app.render();
      void app.openEncapsulationEditor(component.definitionId);
      return;
    }
    if (app.isReadOnlyDraft()) return;
    if (component.type === 'CLOCK') {
      event.preventDefault();
      if (app.editClockPeriod) {
        void app.editClockPeriod(componentId);
      }
      return;
    }
  }

  function rotateSelection(selection, steps) {
    if (app.isReadOnlyDraft()) return;
    if (!selection) {
      return;
    }
    if (selection.kind === 'component') {
      app.commit(rotateComponent(app.getState(), selection.id, steps, { definitions: app.getDefinitions() }));
    } else if (selection.kind === 'multi') {
      app.commit(rotateSelectionCommand(app.getState(), selection.components, steps, { definitions: app.getDefinitions() }));
    }
    app.render();
  }

  function autoRouteSelection(selection) {
    if (app.isReadOnlyDraft()) return;
    const wires = selectionObjects(selection).wires;
    if (wires.length === 0) return;
    app.commit(autoRouteWires(app.getState(), wires, { definitions: app.getDefinitions() }));
    app.render();
  }

  function selectionContains(selection, target) {
    if (!selection || !target) {
      return false;
    }
    if (target.kind === 'component') {
      return (
        (selection.kind === 'component' && selection.id === target.id) ||
        (selection.kind === 'multi' &&
          Array.isArray(selection.components) &&
          selection.components.indexOf(target.id) !== -1)
      );
    }
    if (target.kind === 'frame') {
      return (
        (selection.kind === 'frame' && selection.id === target.id) ||
        (selection.kind === 'multi' &&
          Array.isArray(selection.frames) &&
          selection.frames.indexOf(target.id) !== -1)
      );
    }
    return (
      (selection.kind === 'wire' && selection.id === target.id) ||
      (selection.kind === 'multi' &&
        Array.isArray(selection.wires) &&
        selection.wires.indexOf(target.id) !== -1)
    );
  }

  function handleContextMenu(event) {
    event.preventDefault();
    // 右键打开菜单时放弃尚未开始的 Ctrl/Cmd+拖动复制。
    cancelPendingCopy();
    if (copySession.phase === 'placing' || copySession.phase === 'picking') {
      cancelCopy();
      menu.close();
      return;
    }
    const state = app.getState();
    const screen = eventScreenPoint(event, canvas);
    const world = screenToWorld(screen, app.getView());
    const componentId = hitComponent(state, world, { definitions: app.getDefinitions() });
    const wireHit = componentId ? null : hitWire(state, app.getView(), screen);
    const frameId = componentId || wireHit ? null : hitFrame(state, app.getView(), screen, true);
    if (!componentId && !wireHit && !frameId) {
      menu.close();
      if (app.getMode() !== 'select') {
        disarm();
        app.setMode('select');
        app.render();
      }
      return;
    }

    if (app.getMode() !== 'select') {
      disarm();
      app.setMode('select');
    }

    const target = componentId
      ? { kind: 'component', id: componentId }
      : wireHit
        ? { kind: 'wire', id: wireHit.id }
        : { kind: 'frame', id: frameId };
    const current = app.getSelection();
    if (!selectionContains(current, target)) {
      app.setSelection(target);
    }
    app.render();

    const selection = app.getSelection();
    if (selection && selection.kind === 'port') {
      menu.close();
      return;
    }
    const items = [];
    const customDefinitionId = selectionCustomDefinitionId(state, selection);
    if (customDefinitionId) {
      const highlight = getOscillationHighlight(state, app.evaluation, app.getDefinitions());
      const instanceId = highlight && highlight.componentIds.includes(selection.id) ? selection.id : null;
      items.push({
        label: '详细',
        onSelect: function () {
          void app.openEncapsulationEditor(customDefinitionId, instanceId ? { instanceId } : undefined);
        }
      });
    }
    if (app.isReadOnlyDraft()) {
      if (items.length > 0) {
        menu.openAt(event.clientX, event.clientY, items);
      } else {
        menu.close();
      }
      return;
    }
    if (selection && selection.kind === 'frame') {
      if (canCopySelection(state, selection)) {
        items.push({
          label: '复制',
          onSelect: function () {
            startCopy(selection);
          }
        });
      }
      if (frameForm) {
        items.push({
          label: '编辑',
          onSelect: function () {
            openFrameForm(selection.id);
          }
        });
      }
    } else {
      const single = selection && selection.kind === 'component'
        ? state.components[selection.id]
        : null;
      if (single && single.type === 'CLOCK' && app.editClockPeriod) {
        items.push({
          label: '设置周期…',
          onSelect: function () {
            void app.editClockPeriod(single.id);
          }
        });
      }
      if (canCopySelection(state, selection)) {
        items.push({
          label: '复制',
          onSelect: function () {
            startCopy(selection);
          }
        });
      }
      if (canRotateSelection(state, selection)) {
        items.push({
          label: '左旋 90°',
          onSelect: function () {
            rotateSelection(selection, 3);
          }
        });
        items.push({
          label: '右旋 90°',
          onSelect: function () {
            rotateSelection(selection, 1);
          }
        });
      }
    }
    if (canAutoRouteSelection(state, selection)) {
      items.push({
        label: '自动布线',
        onSelect: function () {
          autoRouteSelection(selection);
        }
      });
    }
    items.push({
      label: '删除',
      onSelect: function () {
        deleteSelection();
      }
    });
    menu.openAt(event.clientX, event.clientY, items);
  }

  function handleKeyDown(event) {
    const target = event.target;
    const isEditable =
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable);
    if (isEditable) {
      return;
    }
    if (frameForm && frameForm.isOpen()) {
      return;
    }

    if (event.code === 'Space') {
      if (target?.closest?.('#encap-inputs button[data-port-id]')) return;
      spaceHeld = true;
      event.preventDefault();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey &&
        event.key?.toLowerCase() === 'c') {
      if (event.defaultPrevented || app.isReadOnlyDraft() || window.getSelection()?.toString()) {
        return;
      }
      event.preventDefault();
      if (!event.repeat && app.getMode() !== 'copy') {
        toggleCopyTool();
      }
      return;
    }

    if (event.key === 'Escape') {
      cancelInputGestures();
      app.setMode('select');
      app.render();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      if (!app.isReadOnlyDraft()) {
        deleteSelection();
      }
    }
  }

  function handleKeyUp(event) {
    if (event.code === 'Space') {
      spaceHeld = false;
    }
  }

  function handleBlur() {
    releaseActiveButton();
    spaceHeld = false;
    cancelCtrlCopyDrag();
  }

  function handlePointerLeave() {
    // pointer capture 不可用且指针移出画布时，pointerup 可能收不到；在此兜底释放。
    releaseActiveButton();
    hoverPinKey = '';
    hoverComponentKey = '';
    if (app.setHoverPin) {
      app.setHoverPin(null);
    }
    if (app.setHoverComponent) {
      app.setHoverComponent(null);
    }
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  canvas.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('pointerup', handlePointerUp);
  canvas.addEventListener('pointercancel', handlePointerCancel);
  canvas.addEventListener('lostpointercapture', function (event) {
    cancelCtrlCopyDrag(event.pointerId);
    cancelPortDrag(event.pointerId);
  });
  canvas.addEventListener('pointerleave', handlePointerLeave);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('dblclick', handleDoubleClick);
  canvas.addEventListener('contextmenu', handleContextMenu);
  canvas.addEventListener('mousedown', function (event) {
    if (event.button === 1) {
      event.preventDefault();
    }
  });
  canvas.addEventListener('auxclick', function (event) {
    if (event.button === 1) {
      event.preventDefault();
    }
  });
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur);
  // 历史恢复可带回按住状态，此时释放可能发生在工具栏而非画布。
  window.addEventListener('pointerup', function () {
    if (restoredButtons.size) releaseActiveButton();
  });
  window.addEventListener('pointercancel', function () {
    if (restoredButtons.size) releaseActiveButton();
  });

  return {
    cancel: cancelInputGestures,
    cancelPortDrag,
    cancelCopyForModeChange,
    trackRestoredButtons: function () {
      restoredButtons = new Set(Object.values(app.getState().components || {})
        .filter(component => component.type === 'BUTTON' && component.on)
        .map(component => component.id));
    },
    cancelWire: function () {
      disarm();
      freeDraw = null;
      marquee = null;
      resetCopySession();
      app.overlay.rubber = null;
      app.overlay.wireStart = null;
      app.overlay.marquee = null;
    },
    captureCopySnapshot: captureCopySnapshot,
    deleteSelection: deleteSelection,
    startCopySnapshot: startCopyWithSnapshot,
    toggleCopyTool: toggleCopyTool
  };
}
