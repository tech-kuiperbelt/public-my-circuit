import { createController } from "./ui/encapsulation-controller.js";
import { createPreview } from "./ui/encapsulation-preview.js";
import { createPanel } from "./ui/encapsulation-panel.js";
import { cloneValue, rootDraftOf, draftRuntimeOptions, draftTestValues, invalidateDraftRuntime, evaluateDraft, resolvePortNet, portNetId, freeSlotFor, normalizeDraftPorts, draftHasChanges } from "./ui/encapsulation-model.js";
// 入口：持有 state/view/selection，装配元件栏、工具栏、菜单、toast 与输入。
import { CLOCK_MAX_PERIOD, CLOCK_MIN_PERIOD } from './core/entities.js';
import { createState } from './core/state.js';
import { evaluateDynamic } from './core/dynamic.js';
import { commitResult } from './core/runtime.js';
import { createSnapshot, prepareSnapshotRestore } from './core/snapshot.js';
import { createEditHistory, captureDraftHistory, restoreDraftHistory } from './ui/edit-history.js';
import {
  advanceClockRuntime,
  createClockRuntime,
  normalizeClockPeriod,
  resetClockRuntime
} from './core/clock.js';
import { CELL, componentBounds, componentDefinition, componentPins, pinWorld, pointInBounds, slotCount, slotOffset } from './core/geometry.js';

import { placeComponent, resetClocksCommand, setClockPeriodCommand } from './core/commands.js';
import { clampScale, hitPortAnnotation, hitPortAnnotationLabel, previewPortLabelRects, previewPortSlots, render, screenToWorld, worldToScreen } from './ui/view.js';
import { getOscillationHighlight, hasVisibleOscillationHighlight } from './ui/oscillation-highlight.js';
import { COMPONENT_SLOTS, createComponentBar, createToolBar, nextMode } from './ui/toolbar.js';
import { resolveComponentDropTarget } from './ui/component-drop-target.js';
import { createComponentBoxController } from './ui/component-box-controller.js';
import { createComponentBox } from './ui/component-box.js';
import { createToolbarLayoutStore, itemKey } from './ui/component-inventory.js';
import { createToast } from './ui/toast.js';
import { createMenu } from './ui/menu.js';
import { cursorSpec, eraserCursor, itemCursor } from './ui/cursor.js';
import { attachInput } from './ui/input.js';
import { createFrameForm } from './ui/frame-form.js';
import { createDialog } from './ui/dialog.js';
import { createSessionStore } from './ui/session-store.js';
import { createSessionController } from './ui/session-controller.js';
import { createSessionUi } from './ui/session-ui.js';
import { createBundleController } from './ui/bundle-controller.js';
import { hasComponentIcon, RESERVED_COMPONENT_ICON_IDS, usedComponentIconIds } from './ui/component-icons.js';
import { createIconPicker } from './ui/icon-picker.js';

const canvas = document.getElementById('board');
const ctx = canvas.getContext('2d');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let lastOscillationPaint = -Infinity;
const componentsElement = document.getElementById('components');
const componentBoxElement = document.getElementById('component-box');
const componentBoxToggleElement = document.getElementById('component-box-toggle');
const componentBoxTabsElement = document.getElementById('component-box-tabs');
const componentBoxTabsPrevElement = document.getElementById('component-box-tabs-prev');
const componentBoxTabsNextElement = document.getElementById('component-box-tabs-next');
const componentBoxPageElement = document.getElementById('component-box-page');
const toolsElement = document.getElementById('tools');
const bundleFileInput = document.getElementById('bundle-file-input');
const toastElement = document.getElementById('toast');
const placementHintElement = document.getElementById('placement-hint');
const menuElement = document.getElementById('menu');
const frameFormElement = document.getElementById('frame-form');
const pinTooltipElement = document.getElementById('pin-tooltip');
const pinTooltipName = document.getElementById('pin-tooltip-name');
const pinTooltipMeta = document.getElementById('pin-tooltip-meta');
const encapPanel = document.getElementById('encap-panel');
const encapBackdrop = document.getElementById('encap-backdrop');
const encapMainBlocker = document.getElementById('encap-main-blocker');
const encapMainNoteText = document.getElementById('encap-main-note-text');
const encapWorkbench = document.getElementById('encap-workbench');
const encapTab = document.getElementById('encap-tab');
const sideTabs = document.getElementById('side-tabs');
const encapWorkbenchHeader = document.getElementById('encap-workbench-header');
const encapWorkbenchTitle = document.getElementById('encap-workbench-title');
const encapWorkbenchCrumb = document.getElementById('encap-workbench-crumb');
const encapWorkbenchFooter = document.getElementById('encap-workbench-footer');
const encapCanvasWindow = document.getElementById('encap-canvas-window');
const encapClose = document.getElementById('encap-close');
const encapCloseDialog = document.getElementById('encap-close-dialog');
const encapCloseCancel = document.getElementById('encap-close-cancel');
const encapCloseDiscard = document.getElementById('encap-close-discard');
const encapCloseSave = document.getElementById('encap-close-save');
const encapKind = document.getElementById('encap-kind');
const encapName = document.getElementById('encap-name');
const encapIconTrigger = document.getElementById('encap-icon-trigger');
const encapIconCurrent = document.getElementById('encap-icon-current');
const encapIconCurrentLabel = document.getElementById('encap-icon-current-label');
const encapIconMenu = document.getElementById('encap-icon-menu');
const encapRows = document.getElementById('encap-rows');
const encapCols = document.getElementById('encap-cols');
const encapAnnotate = document.getElementById('encap-annotate');
const encapRemovePort = document.getElementById('encap-remove-port');
const encapEdit = document.getElementById('encap-edit');
const encapReadonly = document.getElementById('encap-readonly');
const encapSave = document.getElementById('encap-save');
const encapHint = document.getElementById('encap-hint');
const encapPorts = document.getElementById('encap-ports');
const encapInputs = document.getElementById('encap-inputs');
const encapReferences = document.getElementById('encap-references');
const encapPreview = document.getElementById('encap-preview');
const encapPortSection = document.getElementById('encap-port-section');
const encapPreviewTabs = [
  ['layout', document.getElementById('encap-preview-layout'), encapPortSection],
  ['test', document.getElementById('encap-preview-test'), document.getElementById('encap-input-section')],
  ['references', document.getElementById('encap-preview-references'), document.getElementById('encap-reference-section')]
];

const toast = createToast(toastElement);
const menu = createMenu(menuElement);
const frameForm = createFrameForm(frameFormElement);
const dialog = createDialog(document.getElementById('app-dialog'));

function hidePinTooltip() {
  if (!pinTooltipElement) {
    return;
  }
  pinTooltipElement.hidden = true;
  pinTooltipName.textContent = '';
  pinTooltipMeta.textContent = '';
  pinTooltipMeta.hidden = false;
}

function positionPinTooltip(screenPoint) {
  if (!pinTooltipElement) {
    return;
  }
  const rect = pinTooltipElement.getBoundingClientRect();
  const cursor = screenPoint || { x: 0, y: 0 };
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  pinTooltipElement.style.left = Math.min(Math.max(8, cursor.x + 14), maxX) + 'px';
  pinTooltipElement.style.top = Math.min(Math.max(8, cursor.y + 14), maxY) + 'px';
}

function browserLocalStorage() {
  try {
    return window.localStorage;
  } catch (error) {
    return null;
  }
}

const toolbarLayoutStore = createToolbarLayoutStore(browserLocalStorage());
const boxController = createComponentBoxController({
  store: toolbarLayoutStore,
  systemSlots: COMPONENT_SLOTS,
  getDefinitions: () => app.getDefinitions(),
  getHiddenTypes: () => componentBar ? componentBar.getHiddenTypes() : [],
  onChange: refreshComponentSurfaces
});

let componentBar = null;
let componentBox = null;
let iconPicker = null;
let toolBar = null;
let session = null;
let bundleController = null;
const mainHistory = createEditHistory(10);
let historyOwner = null;

// 1 个仿真 tick 对应的真实毫秒；速度只影响“推进多快”，不改变边沿顺序。
const SIMULATION_MS_PER_TICK = 50;
const SIMULATION_MAX_TICKS_PER_FRAME = 200;
const clockRuntime = createClockRuntime();
let clockAccumulatorMs = 0;
let lastFrameTime = null;

const app = {
  state: createState(),
  library: { definitions: {} },
  placeDefinitionId: null,
  draft: null,
  view: { scale: 2, pan: { x: 100, y: 100 } },
  selection: { kind: null, id: null },
  mode: 'select',
  placeType: null,
  tool: null,
  overlay: {
    preview: null,
    hoverAnchor: null,
    hoverPin: null,
    dragGhost: null,
    wireStart: null,
    rubber: null,
    wireDrag: null,
    endpointDrag: null,
    marquee: null,
    groupDrag: null,
    copyGhost: null,
    frameDraw: null,
    frameDrag: null,
    portDrag: null
  },
  evaluation: { ok: true, lampOn: {} },
  session: null,

  getState() {
    return this.state;
  },
  getDefinitions() {
    return this.draft ? this.draft.library : this.library;
  },
  editClockPeriod(componentId) {
    return editClockPeriod(componentId);
  },
  openEncapsulationEditor(definitionId, options) {
    return openEncapsulationEditor(definitionId, options);
  },
  closeEncapsulationEditor() {
    closeEncapsulationEditor();
  },
  saveEncapsulationEditor() {
    return saveEncapsulationEditor();
  },
  setLibrary(library) {
    const next = library && library.definitions ? library : { definitions: {} };
    if (JSON.stringify(this.library) !== JSON.stringify(next)) mainHistory.clear();
    this.library = next;
    syncHistoryTools();
  },
  getHistory() {
    return this.draft ? this.draft.history : mainHistory;
  },
  canMoveHistory() {
    return Boolean(session && session.canEdit() && !this.isReadOnlyDraft() &&
      !(encapCloseDialog && !encapCloseDialog.hidden) && !(encapSave && encapSave.disabled));
  },
  // 草稿属性与端口操作也属于编辑，但不经过电路 command 提交。
  editDraftHistory(edit) {
    const draft = this.draft;
    if (!draft || !this.canMoveHistory()) return false;
    const before = captureDraftHistory(draft);
    const result = edit();
    if (result === false || (result && result.ok === false)) return false;
    if (JSON.stringify(before) !== JSON.stringify(captureDraftHistory(draft))) {
      draft.history.record(before);
    }
    syncHistoryTools();
    return result === undefined ? true : result;
  },
  moveHistory(direction) {
    syncHistoryTools();
    if (!this.canMoveHistory()) return false;
    const history = this.getHistory();
    if (!history) return false;
    const draft = this.draft;
    const current = draft ? captureDraftHistory(draft) : createSnapshot(this.state, this.evaluation);
    const moved = history.move(direction, current, snapshot => {
      // 主图纸使用与首次 Session 加载相同的只读校验，先验证再替换。
      const prepared = draft ? null : prepareSnapshotRestore(snapshot, { definitions: this.library });
      if (prepared && !prepared.ok) {
        toast.show('历史快照无法恢复：' + prepared.reason);
        return false;
      }
      if (input) input.cancel({ discardButton: true });
      preview.resetInteraction();
      if (iconPicker) iconPicker.close();
      if (draft) {
        restoreDraftHistory(draft, snapshot);
        this.state = draft.state;
        this.evaluation = draft.evaluation;
        this.selection = { kind: null, id: null };
        for (const key of Object.keys(this.overlay)) this.overlay[key] = null;
        this.setMode('select');
        menu.close();
        frameForm.close();
        hidePinTooltip();
        // 工具栏 pointerdown 不会自然提交/失焦文本框，强制同步恢复值。
        encapName.value = draft.name;
        encapRows.value = String(draft.rows);
        encapCols.value = String(draft.cols);
        syncDraftPanel();
        updateRuntimeStatus();
        this.render();
      } else {
        this.applyWorkspace({ state: prepared.state, evaluation: prepared.evaluation, view: this.view }, {
          preserveHistory: true
        });
        session.notifyCommit();
      }
      // 原样恢复按住状态；由下一次 pointerup/cancel/blur 释放，避免永久卡住。
      if (input && input.trackRestoredButtons) input.trackRestoredButtons();
      return true;
    });
    syncHistoryTools();
    return moved;
  },
  getView() {
    return this.view;
  },
  setView(view) {
    this.view = view;
    this.overlay.hoverPin = null;
    hidePinTooltip();
    if (session && !this.draft) {
      session.notifyView();
    }
  },
  centerOnBounds(bounds) {
    if (!bounds || !Number.isFinite(bounds.minX) || !Number.isFinite(bounds.maxX) ||
        !Number.isFinite(bounds.minY) || !Number.isFinite(bounds.maxY)) {
      return;
    }
    const width = canvas && canvas.width ? canvas.width : window.innerWidth;
    const height = canvas && canvas.height ? canvas.height : window.innerHeight;
    const scale = this.view.scale;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    this.setView({
      scale,
      pan: {
        x: width / 2 - cx * scale,
        y: height / 2 - cy * scale
      }
    });
  },
  // 悬停管脚：只读取已有 evaluation.pinValue，不触发求值。
  setHoverPin(pin, screenPoint) {
    if (!pin) {
      this.overlay.hoverPin = null;
      hidePinTooltip();
      this.render();
      return;
    }
    const component = this.state.components[pin.componentId];
    const def = component
      ? (componentPins(component, this.getDefinitions()) || []).find(function (item) {
        return item.id === pin.pinId;
      })
      : null;
    if (!component || !def) {
      this.overlay.hoverPin = null;
      hidePinTooltip();
      this.render();
      return;
    }
    this.overlay.hoverPin = {
      componentId: pin.componentId,
      pinId: pin.pinId,
      point: { x: pin.point.x, y: pin.point.y }
    };
    if (!pinTooltipElement) {
      this.render();
      return;
    }
    const key = pin.componentId + ':' + pin.pinId;
    const hasValue = this.evaluation && this.evaluation.pinValue &&
      Object.prototype.hasOwnProperty.call(this.evaluation.pinValue, key);
    pinTooltipName.textContent = def.label || def.id;
    pinTooltipMeta.textContent = (def.dir === 'in' ? 'IN' : 'OUT') +
      ' · ' + (component.type === 'CUSTOM' ? (component.definitionId || 'CUSTOM') : component.type) +
      (hasValue ? ' · 值 ' + this.evaluation.pinValue[key] : '');
    pinTooltipMeta.hidden = false;
    pinTooltipElement.hidden = false;
    positionPinTooltip(screenPoint || worldToScreen(pin.point, this.view));
    this.render();
  },
  // 悬停有图标的封装元件：图纸上不绘制名称，改用 tooltip 显示定义名称。
  setHoverComponent(componentId, screenPoint) {
    const component = componentId ? this.state.components[componentId] : null;
    const definition = component && component.type === 'CUSTOM'
      ? componentDefinition(component, this.getDefinitions())
      : null;
    if (!component || !definition || !hasComponentIcon(definition.icon) || !pinTooltipElement) {
      hidePinTooltip();
      return;
    }
    pinTooltipName.textContent = definition.name || definition.id || 'CUSTOM';
    pinTooltipMeta.textContent = '';
    pinTooltipMeta.hidden = true;
    pinTooltipElement.hidden = false;
    const bounds = componentBounds(component, this.getDefinitions());
    const point = bounds
      ? { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 }
      : { x: component.cx * CELL, y: component.cy * CELL };
    positionPinTooltip(screenPoint || worldToScreen(point, this.view));
  },
  getSelection() {
    return this.selection;
  },
  setSelection(selection) {
    this.selection = selection || { kind: null, id: null };
    if (this.draft) {
      syncDraftPortButtons();
      syncDraftPortSelectionHighlight();
      renderDraftPreview();
    }
  },
  hitPort(screen, raw) {
    if (!this.draft) {
      return null;
    }
    const hit = hitPortAnnotation(draftPortAnnotations(this.draft), this.view, screen, ctx);
    if (!hit || raw) {
      return hit;
    }
    const world = screenToWorld(screen, this.view);
    for (const component of Object.values(this.state.components || {})) {
      if (pointInBounds(world, componentBounds(component, this.draft.library), false)) {
        return null;
      }
    }
    return hit;
  },
  hitPortLabel(screen) {
    if (!this.draft) {
      return null;
    }
    return hitPortAnnotationLabel(draftPortAnnotations(this.draft), this.view, screen, ctx);
  },
  editPortLabel(portId) {
    return editDraftPortLabel(portId);
  },
  removePort(portId) {
    const draft = this.draft;
    if (!draft || draft.readOnly) {
      return false;
    }
    if (!(draft.ports || []).some(function (port) { return port.id === portId; })) {
      return false;
    }
    if (!removeDraftPort(portId)) return false;
    if (this.selection.kind === 'port') {
      this.setSelection({ kind: null, id: null });
    }
    return true;
  },
  previewPortSlots() {
    if (!this.draft || !encapPreview) {
      return [];
    }
    const rect = encapPreview.getBoundingClientRect();
    return previewPortSlots(
      rect.width,
      rect.height,
      draftPreviewDefinition(this.draft),
      this.draft.previewZoom
    )
      .map(function (slot) {
        return Object.assign({}, slot, {
          clientX: rect.left + slot.point.x,
          clientY: rect.top + slot.point.y
        });
      });
  },
  previewPortLabels() {
    if (!this.draft || !encapPreview) {
      return [];
    }
    const rect = encapPreview.getBoundingClientRect();
    return previewPortLabelRects(
      rect.width,
      rect.height,
      draftPreviewDefinition(this.draft),
      ctx,
      this.draft.previewZoom
    ).map(function (label) {
      return Object.assign({}, label, {
        clientX: rect.left + label.rect.x,
        clientY: rect.top + label.rect.y
      });
    });
  },
  previewPortLabelAt(clientX, clientY) {
    if (!this.draft || !encapPreview) {
      return null;
    }
    const rect = encapPreview.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const labels = previewPortLabelRects(
      rect.width,
      rect.height,
      draftPreviewDefinition(this.draft),
      ctx,
      this.draft.previewZoom
    );
    for (let index = labels.length - 1; index >= 0; index -= 1) {
      const label = labels[index];
      const box = label.rect;
      if (localX >= box.x - 2 && localX <= box.x + box.width + 2 &&
          localY >= box.y - 2 && localY <= box.y + box.height + 2) {
        return label;
      }
    }
    return null;
  },
  previewPortTarget(clientX, clientY, portId) {
    return previewPortTarget(this.draft, clientX, clientY, portId);
  },
  setPortDrag(portId, target) {
    this.overlay.portDrag = portId ? { portId, target: target || null } : null;
    if (this.draft) {
      renderDraftPreview();
    }
  },
  dropPortAt(clientX, clientY, portId) {
    const target = previewPortTarget(this.draft, clientX, clientY, portId);
    this.overlay.portDrag = null;
    let moved = false;
    if (target && target.valid) {
      moved = moveDraftPortToSlot(portId, target.side, target.slot);
    } else if (target && !target.valid) {
      toast.show('该槽位已被其他管脚占用');
    }
    if (this.draft) {
      renderDraftPreview();
    }
    app.render();
    return moved;
  },
  getMode() {
    return this.mode;
  },
  setMode(mode) {
    if (this.isReadOnlyDraft() && mode !== 'select') {
      mode = 'select';
    }
    const redrawCopy = input?.cancelCopyForModeChange(mode);
    this.mode = mode;
    if (mode === 'select' || mode === 'annotate' || mode === 'erase-port') {
      this.placeType = null;
      this.placeDefinitionId = null;
      this.tool = null;
    }
    const active = mode === 'select' ? null : this.tool;
    if (componentBar) {
      componentBar.setActive(active);
    }
    if (componentBox) {
      componentBox.setActive(active, this.placeDefinitionId);
    }
    if (toolBar) {
      toolBar.setActive(active);
      syncSimulationToolState();
    }
    updateCursor();
    updatePlacementHint();
    if (this.draft) {
      syncDraftPortButtons();
    }
    if (redrawCopy) this.render();
  },
  isReadOnlyDraft() {
    return Boolean(this.draft && this.draft.readOnly);
  },
  canEdit() {
    return this.draft ? !this.draft.readOnly : (session ? session.canEdit() : false);
  },
  // Session 恢复/New/导入/编辑历史：直接替换完整工作现场，不调用 app.commit。
  applyWorkspace(workspace, options) {
    if (!(options && options.preserveHistory)) mainHistory.clear();
    if (this.draft) {
      const root = rootDraftOf(this.draft);
      root.previous = Object.assign({}, root.previous, {
        state: workspace.state,
        evaluation: workspace.evaluation,
        view: workspace.view
      });
      return;
    }
    // 导入是结构合并，不应把现有主图纸的 CLOCK 相位和暂停状态一起重置。
    if (!(options && options.preserveClockRuntime)) {
      resetClockRuntime(clockRuntime);
      clockRuntime.paused = false;
    }
    clockAccumulatorMs = 0;
    lastFrameTime = null;
    this.state = workspace.state;
    this.evaluation = workspace.evaluation;
    this.view = workspace.view;
    this.selection = { kind: null, id: null };
    this.mode = 'select';
    this.placeType = null;
    this.tool = null;
    for (const key of Object.keys(this.overlay)) {
      this.overlay[key] = null;
    }
    hidePinTooltip();
    if (input) {
      input.cancel({ discardButton: true });
    }
    menu.close();
    frameForm.close();
    toast.hide();
    if (componentBar) {
      componentBar.setActive(null);
    }
    if (componentBox) {
      componentBox.setActive(null);
    }
    if (toolBar) {
      toolBar.setActive(null);
      syncSimulationToolState();
    }
    updateCursor();
    updatePlacementHint();
    updateRuntimeStatus();
    this.render();
  },
  // 事务式提交：先在运行策略层校验候选 state，成功后才替换 state/evaluation。
  // 失败时已提交电路与运行状态保持不变。
  commit(result, options) {
    if (this.draft && this.draft.readOnly) {
      return false;
    }
    if (!this.draft && session && !session.canEdit()) {
      return false;
    }
    let evaluationOptions = { definitions: this.getDefinitions() };
    let updatedPorts;
    if (this.draft && result?.collapsedWireIds?.length) {
      updatedPorts = this.draft.ports.map(port => {
        const binding = port.binding;
        return binding?.kind === 'wire' && result.collapsedWireIds.includes(binding.wireId)
          ? { ...port, binding: { ...binding, wireId: result.id } }
          : port;
      });
    }
    if (this.draft && result?.ok && result.state && !(result.geometryOnly && this.evaluation?.status)) {
      if (result.state === this.draft.state) invalidateDraftRuntime(result.state);
      evaluationOptions = draftRuntimeOptions({
        ...this.draft,
        state: result.state,
        ports: updatedPorts || this.draft.ports
      });
    }
    const committed = commitResult(result, this.evaluation, undefined, evaluationOptions);
    if (!committed.ok) {
      if (committed.reason) {
        toast.show(committed.reason);
      }
      return false;
    }
    if (!(options && options.history === false) &&
        JSON.stringify(this.state) !== JSON.stringify(committed.state)) {
      const history = this.getHistory();
      if (history) history.record(this.draft
        ? captureDraftHistory(this.draft)
        : createSnapshot(this.state, this.evaluation));
    }
    this.state = committed.state;
    this.evaluation = committed.evaluation;
    if (this.draft) {
      if (updatedPorts) this.draft.ports = updatedPorts;
      this.draft.state = committed.state;
      this.draft.evaluation = committed.evaluation;
      renderDraftTestPins();
      if (preview.getMode() === 'test') renderDraftPreview();
    }
    if (this.overlay.hoverPin) {
      this.setHoverPin(this.overlay.hoverPin, null);
    }
    toast.hide();
    updateRuntimeStatus();
    this.render();
    if (session && !this.draft) {
      session.notifyCommit();
    }
    return true;
  },
  render() {
    syncHistoryTools();
    renderFrame();
  }
};

const panel = createPanel({
  app,
  canvas,
  changePortSide,
  changePortSlot,
  encapAnnotate,
  encapBackdrop,
  encapClose,
  encapCols,
  encapEdit,
  encapHint,
  encapIconTrigger,
  encapInputs,
  encapKind,
  encapMainBlocker,
  encapMainNoteText,
  encapName,
  encapPanel,
  encapPortSection,
  encapPorts,
  encapPreviewHeader: document.getElementById('encap-preview-header'),
  encapReadonly,
  encapReferences,
  encapRemovePort,
  encapRows,
  encapSave,
  encapTab,
  encapWorkbench,
  encapWorkbenchCrumb,
  encapWorkbenchHeader,
  encapWorkbenchTitle,
  get iconPicker() { return iconPicker; },
  removeDraftPort,
  renderDraftPreview,
  get session() { return session; },
  sideTabs,
  toast,
  toggleDraftInput
});

const preview = createPreview({
  app,
  cancelBoardPortDrag: () => input?.cancelPortDrag(),
  encapPreview,
  revealDraftPort: panel.revealDraftPort,
  syncDraftPanel,
  toggleDraftInput,
  toast,
  updateMode(mode, draft) {
    for (const [tabMode, button, section] of encapPreviewTabs) {
      const active = mode === tabMode;
      button.setAttribute('aria-pressed', String(active));
      section.hidden = !active;
    }
    const description = mode === 'test'
      ? (draft.inspection ? '元件测试预览，振荡现场输入已冻结' : '元件测试预览，点击输入管脚切换 0 或 1')
      : '元件外观预览';
    encapPreview.setAttribute('aria-label', description);
    encapPreview.title = description;
    updateCursor();
  }
});

const controller = createController({
  resetPreviewInteraction: () => preview.resetInteraction(),
  app,
  captureWorkbenchSnapshot,
  clearWorkbenchPreview,
  get componentBar() {
    return {
      setDefinitions: function () {
        refreshComponentSurfaces();
      },
      setHiddenTypes: function (types) {
        if (componentBar) {
          componentBar.setHiddenTypes(types);
        }
        if (componentBox) {
          componentBox.refresh();
        }
      },
      setActive: function (type, definitionId) {
        if (componentBar) {
          componentBar.setActive(type, definitionId);
        }
        if (componentBox) {
          componentBox.setActive(type, definitionId);
        }
      }
    };
  },
  draftInitialView,
  encapClose,
  encapCloseCancel,
  encapCloseDialog,
  encapCloseDiscard,
  encapCloseSave,
  encapName,
  encapSave,
  formatLibraryError,
  hidePinTooltip,
  onDefinitionSaved: markNewDefinition,
  get iconPicker() { return iconPicker; },
  get input() { return input; },
  revealWorkbenchCanvas,
  get session() { return session; },
  startWorkbenchPreview,
  syncDraftPanel,
  toast,
  get toolBar() { return toolBar; },
  updateCursor,
  updatePlacementHint,
  updateRuntimeStatus
});

iconPicker = createIconPicker({
  trigger: encapIconTrigger,
  menu: encapIconMenu,
  iconElement: encapIconCurrent,
  labelElement: encapIconCurrentLabel,
  // 已被其他定义占用的图标仍然显示，但禁止重复选择。
  // draft.library 已排除当前正在编辑的定义，因此它自己的图标保持可选。
  getDisabledIcons: function () {
    const draft = app.draft;
    if (!draft || !draft.library) {
      return RESERVED_COMPONENT_ICON_IDS;
    }
    const used = usedComponentIconIds(draft.library.definitions, draft.definitionId);
    // 内建 meta 元件已占用 NOT/AND/OR 图标。
    for (const id of RESERVED_COMPONENT_ICON_IDS) {
      used.add(id);
    }
    return used;
  },
  onSelect: function (iconId) {
    const draft = app.draft;
    if (!draft || draft.readOnly) {
      return;
    }
    app.editDraftHistory(() => { draft.icon = iconId; });
    if (iconPicker) {
      iconPicker.setValue(iconId);
    }
    renderDraftPreview();
  }
});

// 常驻运行状态独立于编辑错误 toast，下一次成功操作才更新。
const runtimeStatus = document.createElement('div');
runtimeStatus.id = 'runtime-status';
runtimeStatus.setAttribute('role', 'status');
runtimeStatus.setAttribute('aria-live', 'polite');
runtimeStatus.style.cssText = 'position:fixed;right:18px;top:64px;z-index:25;max-width:360px;padding:10px 14px;background:#4a1515;color:#ffe3e3;border:1px solid #ff6b6b;border-radius:6px;font:14px system-ui';
runtimeStatus.hidden = true;
document.body.appendChild(runtimeStatus);
function updateRuntimeStatus() {
  const status = app.evaluation.status;
  runtimeStatus.dataset.status = status || 'stable';
  runtimeStatus.hidden = status !== 'oscillating' && status !== 'budget';
  runtimeStatus.textContent = status === 'oscillating'
    ? (app.evaluation.cycle
      ? '检测到周期振荡（周期 ' + app.evaluation.cycle.period + ' 轮）。'
      : '自定义元件内部检测到周期振荡。') + '已暂停传播，可修改电路恢复。'
    : status === 'budget' ? '传播超出计算预算，暂未判定稳定性。已保留当前状态，可修改电路。' : '';
  if (status === 'oscillating' && Array.isArray(app.evaluation.oscillation?.componentIds) &&
      app.evaluation.oscillation.componentIds.some(id => app.state.components[id]?.type === 'CUSTOM')) {
    runtimeStatus.textContent += '右键红色封装，选择“详细”可逐层定位。';
  }
}

function draftPortAnchor(draft, binding) {
  if (!binding) return null;
  if (binding.kind === 'pin') {
    const component = draft.state.components[binding.componentId];
    if (!component) return null;
    try {
      const bounds = componentBounds(component, draft.library);
      return {
        point: pinWorld(component, binding.pinId, draft.library),
        center: bounds ? { x: bounds.x + bounds.w / 2, y: bounds.y + bounds.h / 2 } : null
      };
    } catch (error) {
      return null;
    }
  }
  if (binding.kind === 'wire') {
    const wire = draft.state.wires[binding.wireId];
    const points = wire && wire.points;
    if (!points || points.length === 0) return null;
    let point = points[0];
    if (wire.endA && wire.endA.kind === 'free') {
      point = points[0];
    } else if (wire.endB && wire.endB.kind === 'free') {
      point = points[points.length - 1];
    }
    return { point, center: null };
  }
  return null;
}

function draftPortAnnotations(draft) {
  if (!draft) return null;
  const annotations = [];
  for (const port of draft.ports || []) {
    const anchor = draftPortAnchor(draft, port.binding);
    if (!anchor) continue;
    annotations.push({
      id: port.id,
      name: port.name,
      direction: port.direction,
      point: anchor.point,
      center: anchor.center
    });
  }
  return annotations;
}

function renderFrame(timestamp = performance.now()) {
  render(
    ctx,
    canvas.width,
    canvas.height,
    app.state,
    app.view,
    {
      definitions: app.getDefinitions(),
      oscillationTimeMs: timestamp,
      reducedMotion: reducedMotion.matches,
      selection: app.selection,
      preview: app.overlay.preview,
      hoverAnchor: app.overlay.hoverAnchor,
      hoverPin: app.overlay.hoverPin,
      dragGhost: app.overlay.dragGhost,
      wireStart: app.overlay.wireStart,
      rubber: app.overlay.rubber,
      wireDrag: app.overlay.wireDrag,
      endpointDrag: app.overlay.endpointDrag,
      marquee: app.overlay.marquee,
      groupDrag: app.overlay.groupDrag,
      copyGhost: app.overlay.copyGhost,
      frameDraw: app.overlay.frameDraw,
      frameDrag: app.overlay.frameDrag,
      portAnnotations: draftPortAnnotations(app.draft),
      selectedPortId: app.selection.kind === 'port' ? app.selection.id : null
    },
    app.evaluation
  );
}

function updateCursor() {
  if (app.mode === 'annotate') {
    canvas.style.cursor = 'crosshair';
    if (encapPreview) encapPreview.style.cursor = 'default';
    return;
  }
  if (app.mode === 'erase-port') {
    const cursor = eraserCursor();
    canvas.style.cursor = cursor;
    if (encapPreview) encapPreview.style.cursor = preview.getMode() === 'layout' ? cursor : 'default';
    return;
  }
  if (encapPreview) encapPreview.style.cursor = 'default';
  const spec = cursorSpec(app.mode, app.tool);
  canvas.style.cursor = spec.kind === 'tool' ? itemCursor(spec.type) : 'default';
}

// 只在放置/画线/画框模式下显示情境提示，避免常驻干扰。
function updatePlacementHint() {
  if (!placementHintElement) {
    return;
  }
  const frameMode = app.mode === 'frame';
  const wireMode = app.mode === 'wire';
  placementHintElement.hidden = !frameMode && !wireMode && app.mode !== 'place';
  if (frameMode) {
    placementHintElement.textContent = '在图纸上拖动画出分组框（按住 Ctrl/Cmd 可连续画框）';
  } else if (wireMode) {
    placementHintElement.textContent = '按住 Ctrl/Cmd 可连续接线';
  } else {
    placementHintElement.textContent = '按住 Ctrl/Cmd 可连续放置同类型元件';
  }
}

function formatLibraryError(result) {
  if (!result) return '未知错误';
  if (result.reason === 'REFERENCED') {
    return '定义正被实例引用，不能编辑或删除';
  }
  if (result.reason === 'DUPLICATE_NAME') return '定义名称已存在';
  if (result.reason === 'DUPLICATE_ID') return '定义 ID 已存在';
  if (result.reason === 'NOT_FOUND') return '定义不存在';
  if (result.reason === 'NOT_OWNER' || result.reason === 'READ_ONLY') {
    return '当前页面没有编辑权';
  }
  if (result.reason === 'REVISION') return '元件库已被其他页面修改，请重试';
  if (result.reason === 'SESSION_FLUSH_FAILED') return '主图纸保存失败，请先处理';
  if (result.reason === 'INITIAL_NOT_STABLE') return '初态不是 stable，不能保存';
  if (result.reason === 'INITIAL_INPUT_NONZERO') return '封装输入必须为 0';
  if (result.status === 'unsat') return '电路不满足 L1 SAT_ALL，不能保存';
  if (result.status === 'undecided') return 'L1 无法判定（UNDECIDED），不能保存';
  return result.detail || result.reason || '保存失败';
}

function changeDraftSize(rows, cols) {
  const draft = app.draft;
  if (!draft) return;
  if (draft.readOnly) return;
  if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 32 || cols > 32) {
    toast.show('行数和列数必须是 1..32 的整数');
    syncDraftPanel();
    return;
  }
  for (const port of draft.ports) {
    if (port.side && Number.isInteger(port.slot) &&
        !slotOffset(rows, cols, port.side, port.slot)) {
      toast.show('新尺寸放不下已安排的管脚，请先调整槽位');
      syncDraftPanel();
      return;
    }
  }
  app.editDraftHistory(() => {
    draft.rows = rows;
    draft.cols = cols;
    normalizeDraftPorts(draft);
  });
  syncDraftPanel();
  app.render();
}

async function addPortFromPick(binding) {
  const draft = app.draft;
  if (!draft) return;
  if (draft.readOnly) return;
  const resolved = resolvePortNet(draft, binding);
  if (!resolved.net) {
    toast.show('无法解析该连接点的内部 Net');
    return;
  }
  if (resolved.net.driverPins.length > 1) {
    toast.show('该 Net 有多个驱动，不能标注');
    return;
  }
  const direction = resolved.net.driverPins.length === 0 ? 'in' : 'out';
  for (const port of draft.ports) {
    if (portNetId(draft, port) === resolved.netId) {
      toast.show('同一个内部 Net 只能对应一个封装管脚');
      return;
    }
  }
  const defaultName = (direction === 'in' ? 'IN' : 'OUT') + (draft.ports.length + 1);
  const name = await dialog.prompt({
    title: '标注管脚',
    message: '输入管脚名称',
    label: '名称',
    value: defaultName,
    maxLength: 40,
    confirmLabel: '确定',
    cancelLabel: '取消'
  });
  if (name === null) return;
  if (app.draft !== draft || draft.readOnly) return;
  const trimmed = name.trim();
  if (!trimmed) {
    toast.show('管脚名称不能为空');
    return;
  }
  const slot = freeSlotFor(draft);
  if (!slot) {
    toast.show('当前尺寸没有空余槽位，请增加行数或列数');
    return;
  }
  app.editDraftHistory(() => {
    let id = 'p' + draft.nextPortNumber;
    draft.nextPortNumber += 1;
    while (draft.ports.some(function (port) { return port.id === id; })) {
      id = 'p' + draft.nextPortNumber;
      draft.nextPortNumber += 1;
    }
    draft.ports.push({
      id,
      name: trimmed,
      direction,
      binding: cloneValue(binding),
      side: slot.side,
      slot: slot.slot
    });
    if (direction === 'in') draft.inputs[id] = 0;
  });
  syncDraftPanel();
  app.render();
  toast.show('已标注 ' + trimmed + '（' + (direction === 'in' ? 'IN' : 'OUT') + '）');
}

function removeDraftPort(portId) {
  const draft = app.draft;
  if (!draft || draft.readOnly) return false;
  const removed = app.editDraftHistory(() => {
    const ports = draft.ports.filter(port => port.id !== portId);
    const inputs = { ...draft.inputs };
    delete inputs[portId];
    const result = evaluateDraft({ ...draft, ports, inputs }, draft.evaluation);
    if (!result.ok) {
      toast.show('求值失败：' + (result.reason || '未知错误'));
      return false;
    }
    draft.ports = ports;
    draft.inputs = inputs;
    draft.evaluation = result;
    app.evaluation = result;
  });
  if (!removed) return false;
  syncDraftPanel();
  updateRuntimeStatus();
  app.render();
  return true;
}

function changePortSide(port, side) {
  const draft = app.draft;
  if (!draft) return;
  if (draft.readOnly) return;
  const used = new Set(draft.ports.filter(function (item) {
    return item !== port && item.side && Number.isInteger(item.slot);
  }).map(function (item) { return item.side + ':' + item.slot; }));
  const count = slotCount(draft.rows, draft.cols, side);
  let target = -1;
  for (let slot = 0; slot < count; slot += 1) {
    if (!used.has(side + ':' + slot)) {
      target = slot;
      break;
    }
  }
  if (target < 0) {
    toast.show('该边没有空余槽位');
    syncDraftPanel();
    return;
  }
  app.editDraftHistory(() => {
    port.side = side;
    port.slot = target;
  });
  syncDraftPanel();
}

function changePortSlot(port, slot) {
  const draft = app.draft;
  if (!draft) return;
  if (draft.readOnly) return;
  const used = new Set(draft.ports.filter(function (item) {
    return item !== port && item.side && Number.isInteger(item.slot);
  }).map(function (item) { return item.side + ':' + item.slot; }));
  if (used.has(port.side + ':' + slot)) {
    toast.show('该槽位已被其他管脚占用');
    syncDraftPanel();
    return;
  }
  app.editDraftHistory(() => { port.slot = slot; });
  syncDraftPanel();
}

async function editClockPeriod(componentId) {
  if (!app.canEdit()) {
    toast.show('当前为只读，不能修改时钟周期');
    return false;
  }
  const component = app.getState().components[componentId];
  if (!component || component.type !== 'CLOCK') {
    return false;
  }
  const value = await dialog.prompt({
    title: '设置时钟周期',
    message: '周期是一个完整 0→1→0 循环所占的仿真时间单位数。',
    label: '周期',
    value: String(component.period),
    maxLength: 7,
    confirmLabel: '确定',
    cancelLabel: '取消'
  });
  if (value === null) {
    return false;
  }
  const period = normalizeClockPeriod(value);
  if (period === null) {
    toast.show('周期必须是 ' + CLOCK_MIN_PERIOD + ' 到 ' + CLOCK_MAX_PERIOD + ' 的整数');
    return false;
  }
  const current = app.getState().components[componentId];
  if (!current || current.type !== 'CLOCK') {
    return false;
  }
  const result = setClockPeriodCommand(app.getState(), componentId, period);
  if (!app.commit(result)) {
    return false;
  }
  app.setSelection({ kind: 'component', id: componentId });
  app.render();
  return true;
}

function toggleDraftInput(portId) {
  const draft = app.draft;
  // 测试只改变临时运行态，不写定义/Session；只读详情也允许测试。
  if (!draft || draft.inspection || !draft.ports.some(port => port.id === portId && port.direction === 'in') ||
      Object.hasOwn(draftTestValues(draft).pausedInputs, portId)) return;
  const change = () => {
    const next = { ...draft.inputs, [portId]: draft.inputs[portId] ? 0 : 1 };
    const result = evaluateDraft(Object.assign({}, draft, { inputs: next }), draft.evaluation);
    if (!result.ok) {
      toast.show('求值失败：' + (result.reason || '未知错误'));
      return false;
    }
    draft.inputs = next;
    draft.evaluation = result;
    app.evaluation = result;
    return true;
  };
  if (draft.readOnly) change();
  else app.editDraftHistory(change);
  updateRuntimeStatus();
  renderDraftTestPins();
  if (preview.getMode() === 'test') renderDraftPreview();
  app.render();
}

function syncDraftPortSelectionHighlight(...args) { return panel.syncDraftPortSelectionHighlight(...args); }

function renderDraftTestPins(...args) { return panel.renderDraftTestPins(...args); }

function captureWorkbenchSnapshot() {
  if (!encapBackdrop) {
    return;
  }
  try {
    encapBackdrop.style.backgroundImage = 'url("' + canvas.toDataURL('image/png') + '")';
  } catch (error) {
    encapBackdrop.style.backgroundImage = 'none';
  }
}

const WORKBENCH_PREVIEW_DELAY_MS = 380;
let workbenchPreviewTimer = null;
let workbenchPreview = null;

function clearWorkbenchPreview() {
  if (workbenchPreviewTimer !== null) {
    clearTimeout(workbenchPreviewTimer);
    workbenchPreviewTimer = null;
  }
  if (workbenchPreview && workbenchPreview.parentNode) {
    workbenchPreview.parentNode.removeChild(workbenchPreview);
  }
  workbenchPreview = null;
}

function revealWorkbenchCanvas() {
  canvas.classList.add('encap-board-revealed');
}

function workbenchMetrics() {
  const drawerWidth = encapWorkbench && encapWorkbench.offsetWidth
    ? encapWorkbench.offsetWidth
    : window.innerWidth * 0.66666;
  const contentLeft = Math.max(0, window.innerWidth - drawerWidth) +
    (encapWorkbench ? encapWorkbench.clientLeft : 0);
  const headerHeight = encapWorkbenchHeader && encapWorkbenchHeader.offsetHeight
    ? encapWorkbenchHeader.offsetHeight
    : 58;
  const workbenchTop = encapWorkbench
    ? encapWorkbench.getBoundingClientRect().top + encapWorkbench.clientTop
    : 52;
  return { contentLeft, contentTop: workbenchTop + headerHeight, headerHeight };
}

function startWorkbenchPreview() {
  clearWorkbenchPreview();
  canvas.classList.remove('encap-board-revealed');
  if (!encapCanvasWindow || !canvas.width || !canvas.height) {
    revealWorkbenchCanvas();
    return;
  }
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    revealWorkbenchCanvas();
    return;
  }
  try {
    const preview = document.createElement('canvas');
    preview.className = 'encap-canvas-preview';
    preview.width = canvas.width;
    preview.height = canvas.height;
    const previewContext = preview.getContext('2d');
    previewContext.drawImage(canvas, 0, 0);
    const metrics = workbenchMetrics();
    preview.style.left = (-metrics.contentLeft) + 'px';
    preview.style.top = (-metrics.contentTop) + 'px';
    preview.style.width = window.innerWidth + 'px';
    preview.style.height = window.innerHeight + 'px';
    encapCanvasWindow.appendChild(preview);
    workbenchPreview = preview;
    workbenchPreviewTimer = window.setTimeout(function () {
      workbenchPreviewTimer = null;
      clearWorkbenchPreview();
      revealWorkbenchCanvas();
    }, WORKBENCH_PREVIEW_DELAY_MS);
  } catch (error) {
    revealWorkbenchCanvas();
  }
}

function draftContentBounds(draft) {
  if (!draft) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let found = false;
  function include(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    found = true;
  }
  for (const component of Object.values(draft.state.components || {})) {
    const bounds = componentBounds(component, draft.library);
    if (!bounds) continue;
    include(bounds.x, bounds.y);
    include(bounds.x + bounds.w, bounds.y + bounds.h);
  }
  for (const wire of Object.values(draft.state.wires || {})) {
    for (const point of wire.points || []) {
      include(point.x, point.y);
    }
  }
  for (const frame of Object.values(draft.state.frames || {})) {
    include(frame.x, frame.y);
    include(frame.x + frame.w, frame.y + frame.h);
  }
  if (!found) return null;
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function draftInitialView(draft) {
  const metrics = workbenchMetrics();
  const drawerWidth = encapWorkbench && encapWorkbench.offsetWidth
    ? encapWorkbench.offsetWidth
    : window.innerWidth * 0.66666;
  const panelWidth = encapPanel && !encapPanel.hidden ? encapPanel.offsetWidth : 0;
  const footerHeight = encapWorkbenchFooter && !encapWorkbenchFooter.hidden
    ? encapWorkbenchFooter.offsetHeight
    : 0;
  const workbenchHeight = encapWorkbench && encapWorkbench.offsetHeight
    ? encapWorkbench.offsetHeight
    : window.innerHeight - metrics.contentTop - 40;
  const content = {
    x: metrics.contentLeft,
    y: metrics.contentTop,
    w: encapCanvasWindow && encapCanvasWindow.clientWidth
      ? encapCanvasWindow.clientWidth
      : Math.max(1, drawerWidth - panelWidth),
    h: encapCanvasWindow && encapCanvasWindow.clientHeight
      ? encapCanvasWindow.clientHeight
      : Math.max(1, workbenchHeight - metrics.headerHeight - footerHeight)
  };
  const bounds = draftContentBounds(draft);
  if (!bounds || bounds.w <= 0 || bounds.h <= 0) {
    return {
      scale: 2,
      pan: { x: content.x + 120, y: content.y + 120 }
    };
  }
  const padding = Math.min(80, Math.max(24, Math.min(content.w, content.h) * 0.1));
  const availableWidth = Math.max(1, content.w - padding * 2);
  const availableHeight = Math.max(1, content.h - padding * 2);
  const scale = clampScale(Math.min(
    availableWidth / Math.max(1, bounds.w),
    availableHeight / Math.max(1, bounds.h)
  ));
  const worldCenterX = bounds.x + bounds.w / 2;
  const worldCenterY = bounds.y + bounds.h / 2;
  const screenCenterX = content.x + content.w / 2;
  const screenCenterY = content.y + content.h / 2;
  return {
    scale,
    pan: {
      x: screenCenterX - worldCenterX * scale,
      y: screenCenterY - worldCenterY * scale
    }
  };
}

async function editDraftPortLabel(portId) {
  const draft = app.draft;
  if (!draft) {
    return false;
  }
  const port = (draft.ports || []).find(function (item) { return item.id === portId; });
  if (!port) {
    return false;
  }
  if (draft.readOnly) {
    toast.show('只读详情不能修改管脚名称');
    return false;
  }
  const value = await dialog.prompt({
    title: '修改管脚名称',
    message: '输入新的管脚名称',
    label: '名称',
    value: port.name,
    maxLength: 40,
    confirmLabel: '确定',
    cancelLabel: '取消'
  });
  if (value === null) {
    return false;
  }
  if (app.draft !== draft || draft.readOnly) {
    return false;
  }
  const current = (draft.ports || []).find(function (item) { return item.id === portId; });
  if (!current) {
    return false;
  }
  const name = value.trim();
  if (!name) {
    toast.show('管脚名称不能为空');
    return false;
  }
  app.editDraftHistory(() => { current.name = name; });
  syncDraftPanel();
  app.render();
  return true;
}

function draftPreviewDefinition(...args) { return preview.draftPreviewDefinition(...args); }

function previewPortTarget(...args) { return preview.previewPortTarget(...args); }

function handlePreviewPointerDown(...args) { return preview.handlePreviewPointerDown(...args); }

function handlePreviewPointerMove(...args) { return preview.handlePreviewPointerMove(...args); }

function handlePreviewPointerLeave(...args) { return preview.handlePreviewPointerLeave(...args); }

function handlePreviewPointerUp(...args) { return preview.handlePreviewPointerUp(...args); }

function handlePreviewPointerCancel(...args) { return preview.handlePreviewPointerCancel(...args); }

function handlePreviewWheel(...args) { return preview.handlePreviewWheel(...args); }

function handlePreviewDoubleClick(...args) { return preview.handlePreviewDoubleClick(...args); }

function moveDraftPortToSlot(...args) {
  return app.editDraftHistory(() => preview.moveDraftPortToSlot(...args));
}

function renderDraftPreview(...args) { return preview.renderDraftPreview(...args); }

function syncWorkbenchCrumb(...args) { return panel.syncWorkbenchCrumb(...args); }

function syncWorkbenchHeading(...args) { return panel.syncWorkbenchHeading(...args); }

function syncDraftPortButtons(...args) { return panel.syncDraftPortButtons(...args); }

// 侧签顶部与工作台图纸上边沿对齐（扣除工作台边框和标题栏）。
function syncSideTabsTop(...args) { return panel.syncSideTabsTop(...args); }

function syncDraftPanel(...args) { return panel.syncDraftPanel(...args); }

function openEncapsulationEditor(...args) {
  setBoxOnTop(false);
  return controller.openEncapsulationEditor(...args);
}

function switchEncapsulationToEdit(...args) { return controller.switchEncapsulationToEdit(...args); }

function cancelEncapCloseDialog(...args) { return controller.cancelEncapCloseDialog(...args); }

function discardEncapCloseDialog(...args) { return controller.discardEncapCloseDialog(...args); }

function saveEncapCloseDialog(...args) { return controller.saveEncapCloseDialog(...args); }

function requestCloseEncapsulationEditor(...args) { return controller.requestCloseEncapsulationEditor(...args); }

function closeEncapsulationEditor(...args) { return controller.closeEncapsulationEditor(...args); }

function saveEncapsulationEditor(...args) { return controller.saveEncapsulationEditor(...args); }

function deleteDefinitionFromBar(...args) { return controller.deleteDefinitionFromBar(...args); }

app.onAnnotatePick = function (pick) {
  if (!app.draft || app.draft.readOnly) return undefined;
  return addPortFromPick(pick.binding);
};

encapAnnotate.addEventListener('click', function () {
  if (!app.draft || app.draft.readOnly) return;
  app.setMode(app.mode === 'annotate' ? 'select' : 'annotate');
  syncDraftPanel();
});
encapRemovePort.addEventListener('click', function () {
  const draft = app.draft;
  if (!draft || draft.readOnly) return;
  if (app.selection.kind === 'port' &&
      (draft.ports || []).some(function (port) { return port.id === app.selection.id; })) {
    app.removePort(app.selection.id);
    app.render();
    return;
  }
  app.setMode(app.mode === 'erase-port' ? 'select' : 'erase-port');
  syncDraftPanel();
});
encapEdit.addEventListener('click', function () {
  void switchEncapsulationToEdit();
});
encapSave.addEventListener('click', function () { void saveEncapsulationEditor(); });
encapName.addEventListener('change', function () {
  if (!app.draft || app.draft.readOnly) return;
  const value = encapName.value.trim();
  if (!value) {
    encapName.value = app.draft.name;
    toast.show('定义名称不能为空');
    return;
  }
  app.editDraftHistory(() => { app.draft.name = value; });
  syncWorkbenchHeading(app.draft);
  syncWorkbenchCrumb(app.draft);
  renderDraftPreview();
});
encapRows.addEventListener('change', function () {
  if (!app.draft || app.draft.readOnly) return;
  changeDraftSize(Number(encapRows.value), app.draft.cols);
});
encapCols.addEventListener('change', function () {
  if (!app.draft || app.draft.readOnly) return;
  changeDraftSize(app.draft.rows, Number(encapCols.value));
});

function resize() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  syncSideTabsTop();
  hidePinTooltip();
  app.render();
  renderDraftPreview();
}

let input = null;

// 点击元件图标或工具按钮后的统一状态切换。
function activateItem(type, definitionId) {
  if (app.isReadOnlyDraft()) {
    toast.show('只读详情不能编辑；请先点击“编辑”');
    return;
  }
  const switchingCustom = type === 'CUSTOM' && app.mode === 'place' &&
    app.tool === 'CUSTOM' && app.placeDefinitionId !== (definitionId || null);
  const next = switchingCustom
    ? { mode: 'place', type: 'CUSTOM' }
    : nextMode({ mode: app.mode, type: app.tool }, type);
  app.mode = next.mode;
  app.placeType = next.mode === 'place' ? next.type : null;
  app.placeDefinitionId = next.mode === 'place' && type === 'CUSTOM' ? definitionId : null;
  app.tool = next.type;
  const active = next.mode === 'select' ? null : next.type;
  if (componentBar) {
    componentBar.setActive(active, app.placeDefinitionId);
  }
  if (componentBox) {
    componentBox.setActive(active, app.placeDefinitionId);
  }
  if (toolBar) {
    toolBar.setActive(active);
    syncSimulationToolState();
  }
  updateCursor();
  updatePlacementHint();
  app.overlay.preview = null;
  app.overlay.hoverAnchor = null;
  app.overlay.wireStart = null;
  app.overlay.rubber = null;
  app.overlay.wireDrag = null;
  app.overlay.endpointDrag = null;
  app.overlay.marquee = null;
  app.overlay.groupDrag = null;
  app.overlay.copyGhost = null;
  app.overlay.frameDraw = null;
  app.overlay.frameDrag = null;
  if (input && input.cancelWire) {
    input.cancelWire();
  }
  app.render();
}

function markNewDefinition(definition, isNew) {
  boxController.markNewDefinition(definition, isNew);
}

function setBoxOnTop(onTop) {
  if (!componentBoxElement) {
    return;
  }
  const next = Boolean(onTop);
  const was = componentBoxElement.classList.contains('box-on-top');
  componentBoxElement.classList.toggle('box-on-top', next);
  if (next && !was && componentBox) {
    componentBox.refresh();
  }
}

function refreshComponentSurfaces() {
  if (componentBar) {
    componentBar.setInventoryContext(app.getDefinitions(), boxController.getLayout().hidden);
  }
  if (componentBox) {
    componentBox.refresh();
  }
}

async function renameBoxTab(pageIndex, currentLabel) {
  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    return;
  }
  const label = await dialog.prompt({
    title: '重命名箱子页签',
    message: '修改自定义页签的显示名称。',
    label: '页签名称',
    value: currentLabel,
    maxLength: 20,
    confirmLabel: '保存'
  });
  if (label === null) {
    return;
  }
  const trimmed = label.trim();
  if (!trimmed) {
    toast.show('页签名称不能为空');
    return;
  }
  if (trimmed === currentLabel) {
    return;
  }
  boxController.renameTab(pageIndex, trimmed);
}

function addBoxTab() { return boxController.addTab(); }
function deleteBoxTab(pageIndex) { return boxController.deleteTab(pageIndex); }
function moveBoxItemToTab(item, targetPage) {
  if (!item || item.kind !== 'custom') return false;
  const source = boxController.getInventory().positions[item.key];
  if (source && source.page === targetPage) return false;
  const moved = boxController.moveToTab(item.key, targetPage);
  if (!moved) toast.show('目标页签已满，无法放入该元件');
  return moved;
}
function moveBoxItem(item, page, cell) {
  return item && boxController.move(item.key, page, cell);
}
function pinToolbarItem(item) { return item && boxController.pin(item.key); }
function removeToolbarItem(type, definitionId) {
  boxController.unpin(itemKey(type, definitionId));
  if (input && input.cancelWire) {
    input.cancelWire();
  }
  if (app.getMode() !== 'select') {
    app.setMode('select');
  } else {
    if (componentBar) {
      componentBar.setActive(null);
    }
    if (componentBox) {
      componentBox.setActive(null);
    }
  }
}

function openCustomDefinitionMenu(item, event) {
  const definitionId = item.definitionId;
  const menuItems = [
    {
      label: '详细',
      onSelect: function () { openEncapsulationEditor(definitionId); }
    }
  ];
  if (item.pinned !== false) {
    menuItems.push({
      label: '从元件栏移除',
      onSelect: function () { removeToolbarItem(item.type, definitionId); }
    });
  }
  menuItems.push({
    label: '删除定义',
    onSelect: function () { void deleteDefinitionFromBar(definitionId); }
  });
  menu.openAt(event.clientX, event.clientY, menuItems);
}

function isDropOnCanvas(clientX, clientY) {
  return resolveComponentDropTarget(document, clientX, clientY).kind === 'canvas';
}

function placeFromComponentBar(type, clientX, clientY, keepActive, definitionId) {
  const rect = canvas.getBoundingClientRect();
  const screen = { x: clientX - rect.left, y: clientY - rect.top };
  const world = screenToWorld(screen, app.view);
  const cx = Math.floor(world.x / CELL);
  const cy = Math.floor(world.y / CELL);
  const result = placeComponent(app.state, type, cx, cy, {
    definitionId: definitionId || app.placeDefinitionId,
    definitions: app.getDefinitions()
  });
  if (app.commit(result)) {
    app.setSelection({ kind: 'component', id: result.id });
    // Ctrl/Cmd 按住时保持元件栏激活，便于连续放置同一类型。
    if (!keepActive) {
      app.setMode('select');
    }
    app.render();
    return true;
  }
  return false;
}

function startComponentDragFromBar(type, event, definitionId) {
  if (app.isReadOnlyDraft()) {
    toast.show('只读详情不能编辑；请先点击“编辑”');
    return;
  }
  const pointerId = event && event.pointerId;
  const ctrl = Boolean(event && (event.ctrlKey || event.metaKey));
  // 左键按下元件图标即进入选中状态（高亮 + 对应光标），不等松开。
  // 已经激活且按住 Ctrl/Cmd 时保持激活，避免再次按下同一图标被当作“取消”。
  if (!(app.getMode() === 'place' && app.tool === type &&
        app.placeDefinitionId === (definitionId || null) && ctrl)) {
    activateItem(type, definitionId);
  }

  function cleanup() {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onCancel);
    window.removeEventListener('blur', cleanup);
  }

  function onMove() {
    // 拖动期间无需额外反馈；落点由松开位置决定。
  }

  function onUp(event) {
    if (event.pointerId !== pointerId) return;
    cleanup();
    if (['box', 'cell', 'tab'].includes(resolveComponentDropTarget(document, event.clientX, event.clientY).kind)) {
      removeToolbarItem(type, definitionId);
      return;
    }
    if (isDropOnCanvas(event.clientX, event.clientY)) {
      placeFromComponentBar(
        type,
        event.clientX,
        event.clientY,
        event.ctrlKey || event.metaKey,
        definitionId
      );
    }
    // 松开在栏内/栏外都不再切换：按下时已经进入选中状态。
  }

  function onCancel(event) {
    if (event.pointerId !== pointerId) return;
    cleanup();
  }

  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
  window.addEventListener('blur', cleanup);
}

function applyClockAdvance(result) {
  if (!result || result.ok !== true || !result.changed) {
    return false;
  }
  app.state = result.state;
  app.evaluation = result.evaluation;
  if (app.draft) {
    app.draft.state = result.state;
    app.draft.evaluation = result.evaluation;
  }
  updateRuntimeStatus();
  app.render();
  return true;
}

function syncSimulationToolState() {
  if (toolBar && toolBar.setItemActive) {
    toolBar.setItemActive('SIM_PAUSE', clockRuntime.paused);
  }
}

function syncHistoryTools() {
  if (session) {
    const owner = session.getStatus().owner;
    if (historyOwner !== null && historyOwner !== owner) mainHistory.clear();
    historyOwner = owner;
  }
  if (!toolBar || !toolBar.setItemDisabled) return;
  const history = app.getHistory();
  const enabled = app.canMoveHistory();
  toolBar.setItemDisabled('UNDO', !enabled || !history || !history.canUndo());
  toolBar.setItemDisabled('REDO', !enabled || !history || !history.canRedo());
}

function toggleClockSimulation() {
  clockRuntime.paused = !clockRuntime.paused;
  clockAccumulatorMs = 0;
  lastFrameTime = null;
  if (clockRuntime.paused && session && !app.draft) {
    // 暂停是自然的保存点：把当前 CLOCK 相位写入 Session。
    session.notifyCommit();
  }
  syncSimulationToolState();
}

function resetClockSimulation() {
  if (!app.canEdit()) {
    toast.show('当前为只读，不能重置仿真');
    return false;
  }
  resetClockRuntime(clockRuntime);
  clockAccumulatorMs = 0;
  lastFrameTime = null;
  const result = resetClocksCommand(app.state);
  app.commit(result, { history: false });
  app.render();
  return true;
}

function simulationFrame(timestamp) {
  window.requestAnimationFrame(simulationFrame);
  syncHistoryTools();
  // 脉动只重绘画布，不求值、不创建编辑历史，也不触发Session保存。
  // 独立于时钟暂停和封装工作台；静态/屏外高亮不持续重绘。
  if (!reducedMotion.matches && !document.hidden && timestamp - lastOscillationPaint >= 1000 / 30) {
    const definitions = app.getDefinitions();
    const highlight = getOscillationHighlight(app.state, app.evaluation, definitions);
    if (hasVisibleOscillationHighlight(app.state, app.view, canvas.width, canvas.height, highlight, definitions)) {
      lastOscillationPaint = timestamp;
      renderFrame(timestamp);
    }
  }
  if (lastFrameTime === null) {
    lastFrameTime = timestamp;
    return;
  }
  const elapsed = Math.max(0, timestamp - lastFrameTime);
  lastFrameTime = timestamp;

  // Session 事务期间冻结状态与调度器，避免异步写入后应用旧状态却保留新相位。
  // 与暂停/封装工作台一致：不累计等待期间的补跑时间。
  if (clockRuntime.paused || app.draft || (session && session.getStatus().busy)) {
    clockAccumulatorMs = 0;
    return;
  }

  clockAccumulatorMs += elapsed;
  const dueTicks = Math.floor(clockAccumulatorMs / SIMULATION_MS_PER_TICK);
  if (dueTicks <= 0) {
    return;
  }
  const processTicks = Math.min(dueTicks, SIMULATION_MAX_TICKS_PER_FRAME);
  clockAccumulatorMs -= processTicks * SIMULATION_MS_PER_TICK;
  if (clockAccumulatorMs > SIMULATION_MS_PER_TICK * SIMULATION_MAX_TICKS_PER_FRAME) {
    clockAccumulatorMs = SIMULATION_MS_PER_TICK * SIMULATION_MAX_TICKS_PER_FRAME;
  }

  const result = advanceClockRuntime(
    clockRuntime,
    app.state,
    app.evaluation,
    clockRuntime.time + processTicks,
    undefined,
    { definitions: app.getDefinitions() }
  );
  if (result.ok === true) {
    applyClockAdvance(result);
  }
}

componentBar = createComponentBar(componentsElement, {
  onWireToggle: function () {
    activateItem('WIRE');
  },
  onFrameToggle: function () {
    activateItem('FRAME');
  },
  onComponentDragStart: startComponentDragFromBar,
  onDefinitionDoubleClick: openEncapsulationEditor,
  onItemContextMenu: function (item, event) {
    if (item.type === 'CUSTOM') {
      openCustomDefinitionMenu(item, event);
      return;
    }
    menu.openAt(event.clientX, event.clientY, [{
      label: '从元件栏移除',
      onSelect: function () { removeToolbarItem(item.type, item.definitionId); }
    }]);
  }
});
componentBar.setHiddenKeys(boxController.getLayout().hidden);
componentBar.setActive(null);

componentBox = createComponentBox({
  toggle: componentBoxToggleElement,
  panel: componentBoxElement,
  tabs: componentBoxTabsElement,
  tabsPrev: componentBoxTabsPrevElement,
  tabsNext: componentBoxTabsNextElement,
  page: componentBoxPageElement,
  getInventory: () => boxController.getInventory(),
  getPendingItem: () => boxController.getLayout().pendingNewItem,
  canMarkSeen: function () {
    return !app.draft ||
      (componentBoxElement && componentBoxElement.classList.contains('box-on-top'));
  },
  onPendingItemSeen: key => boxController.markSeen(key),
  isActive: function (item) {
    return app.getMode() === 'place' && app.tool === item.type &&
      (item.type !== 'CUSTOM' || app.placeDefinitionId === (item.definitionId || null));
  },
  isOverCanvas: isDropOnCanvas,
  onActivate: function (item) {
    activateItem(item.type, item.definitionId);
  },
  onPlace: function (item, clientX, clientY, keepActive) {
    if (app.isReadOnlyDraft()) {
      toast.show('只读详情不能编辑；请先点击“编辑”');
      return;
    }
    placeFromComponentBar(item.type, clientX, clientY, keepActive, item.definitionId);
  },
  onPin: pinToolbarItem,
  onMove: moveBoxItem,
  onMoveToTab: moveBoxItemToTab,
  onRenameTab: renameBoxTab,
  onAddTab: addBoxTab,
  onDeleteTab: deleteBoxTab,
  onDefinitionContextMenu: openCustomDefinitionMenu,
  onDefinitionDoubleClick: openEncapsulationEditor
});
componentBox.setActive(null);

if (componentBoxElement) {
  componentBoxElement.addEventListener('pointerdown', function () {
    setBoxOnTop(true);
  }, true);
}
if (componentBoxToggleElement) {
  componentBoxToggleElement.addEventListener('pointerdown', function () {
    setBoxOnTop(true);
  }, true);
}
if (encapWorkbench) {
  encapWorkbench.addEventListener('pointerdown', function () {
    setBoxOnTop(false);
  }, true);
}
if (sideTabs) {
  sideTabs.addEventListener('pointerdown', function () {
    setBoxOnTop(false);
  }, true);
}

toolBar = createToolBar(toolsElement, {
  onUndo: function () { app.moveHistory('undo'); },
  onRedo: function () { app.moveHistory('redo'); },
  onExport: function () {
    if (!bundleController) {
      toast.show('Session 尚未就绪');
      return;
    }
    void bundleController.exportBundle();
  },
  onImport: function () {
    if (!bundleController) {
      toast.show('Session 尚未就绪');
      return;
    }
    bundleController.openImportPicker();
  },
  onNewSession: function () {
    if (app.draft) {
      toast.show(app.draft.readOnly ? '请先关闭封装详情' : '请先保存或取消封装编辑');
      return;
    }
    if (session) {
      void session.requestNew();
    }
  },
  onToggleSimulation: function () {
    toggleClockSimulation();
  },
  onResetSimulation: function () {
    resetClockSimulation();
  },
  onCopyTool: function () {
    if (app.isReadOnlyDraft()) {
      toast.show('只读详情不能编辑；请先点击“编辑”');
      return;
    }
    if (input && input.toggleCopyTool) {
      input.toggleCopyTool();
    }
  },
  onDeleteTool: function () {
    if (app.isReadOnlyDraft()) {
      toast.show('只读详情不能编辑；请先点击“编辑”');
      return;
    }
    const selection = app.getSelection();
    const hasSelection = Boolean(selection) && (
      ((selection.kind === 'component' || selection.kind === 'wire' || selection.kind === 'frame') && selection.id) ||
      (selection.kind === 'multi' && (
        (Array.isArray(selection.components) && selection.components.length > 0) ||
        (Array.isArray(selection.wires) && selection.wires.length > 0) ||
        (Array.isArray(selection.frames) && selection.frames.length > 0)
      ))
    );
    // 已有选中对象时，“删”按钮直接删除它；没有选中时才进入删除工具。
    if (
      app.getMode() !== 'delete' &&
      hasSelection &&
      input &&
      input.deleteSelection
    ) {
      if (input.cancelWire) {
        input.cancelWire();
      }
      input.deleteSelection();
      return;
    }
    activateItem('DELETE');
  }
});
toolBar.setActive(null);
syncSimulationToolState();
updateCursor();
updatePlacementHint();
syncSideTabsTop();

function getOrCreateTabId() {
  const key = 'my-circuit-tab-id';
  try {
    let id = window.sessionStorage.getItem(key);
    if (!id) {
      id = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
      window.sessionStorage.setItem(key, id);
    }
    return id;
  } catch (error) {
    return (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
      ? crypto.randomUUID()
      : 'tab-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  }
}
const sessionUi = createSessionUi(document);
const sessionStore = createSessionStore({ indexedDB: window.indexedDB });
session = createSessionController({
  store: sessionStore,
  ui: sessionUi,
  tabId: getOrCreateTabId(),
  confirm: function (message, options) {
    const opts = options || {};
    return dialog.confirm({
      title: opts.title || '请确认',
      message,
      confirmLabel: opts.confirmLabel || '确定',
      cancelLabel: opts.cancelLabel || '取消',
      danger: Boolean(opts.danger)
    });
  },
  getWorkspace: function () {
    if (app.draft) {
      return rootDraftOf(app.draft).previous;
    }
    return { state: app.state, evaluation: app.evaluation, view: app.view };
  },
  applyWorkspace: function (workspace) {
    app.applyWorkspace(workspace);
  },
  createBlankWorkspace: function () {
    const state = createState();
    return {
      state,
      evaluation: evaluateDynamic(state, undefined, undefined, {
        definitions: app.library
      }),
      view: { scale: 2, pan: { x: 100, y: 100 } }
    };
  },
  applyLibrary: function (library) {
    app.setLibrary(library);
    refreshComponentSurfaces();
  }
});
app.session = session;

try {
  await session.initialize();
} catch (error) {
  console.error('Session initialization failed', error);
  sessionUi.showBlocker('Session 初始化失败', String(error && error.message || error), [{
    label: '重试',
    primary: true,
    onClick: function () { window.location.reload(); }
  }]);
}

bundleController = createBundleController({
  app,
  session,
  dialog,
  toast,
  fileInput: bundleFileInput
});
if (bundleFileInput) {
  bundleFileInput.addEventListener('change', function () {
    const file = bundleFileInput.files && bundleFileInput.files[0];
    bundleFileInput.value = '';
    if (bundleController) {
      void bundleController.handleFile(file);
    }
  });
}

function handleWorkbenchOutsidePointer(event) {
  const draft = app.draft;
  if (!draft || !encapWorkbench) {
    return;
  }
  if (encapWorkbench.contains(event.target)) return;
  // 只读详情或未做任何修改的草稿可直接点击图纸区域关闭；有修改时避免误触丢失。
  if (!draft.readOnly && draftHasChanges(draft, encapName ? encapName.value.trim() : draft.name)) {
    return;
  }
  if (!draft.readOnly) {
    // 左侧元件栏、顶部工具栏、菜单等编辑控件不属于“工作台外部”，点击时不关闭草稿。
    const target = event.target;
    // 画布本身是工作台内可交互的图纸区域；左侧主图纸区域由 main-blocker 接收点击。
    const inDrawing = target === document.body || target === document.documentElement ||
      (encapMainBlocker && encapMainBlocker.contains(target)) ||
      (encapBackdrop && encapBackdrop.contains(target));
    if (!inDrawing) {
      return;
    }
  }
  const left = encapWorkbench.offsetLeft;
  const top = encapWorkbench.offsetTop;
  const right = left + encapWorkbench.offsetWidth;
  const bottom = top + encapWorkbench.offsetHeight;
  const inside = event.clientX >= left && event.clientX <= right &&
    event.clientY >= top && event.clientY <= bottom;
  if (!inside) {
    closeEncapsulationEditor();
  }
}

input = attachInput({ canvas, app, toast, menu, frameForm });
if (encapTab) {
  encapTab.addEventListener('click', function (event) {
    if (app.draft) {
      return;
    }
    // Ctrl/Cmd+点击「封装电路」：把当前选择作为复制源带入新封装工作台。
    if ((event.ctrlKey || event.metaKey) && input && input.captureCopySnapshot) {
      const copySnapshot = input.captureCopySnapshot(app.getSelection());
      if (copySnapshot) {
        if (copySnapshot.components.some(function (component) {
          return component && component.type === 'CLOCK';
        })) {
          toast.show('封装电路暂不支持 CLOCK');
          return;
        }
        void openEncapsulationEditor(null, { copySnapshot });
        return;
      }
    }
    void openEncapsulationEditor(null);
  });
}
if (encapPreview) {
  for (const [mode, button] of encapPreviewTabs) {
    button.addEventListener('click', () => preview.setMode(mode));
  }
  encapPreview.addEventListener('pointerdown', handlePreviewPointerDown);
  encapPreview.addEventListener('pointermove', handlePreviewPointerMove);
  encapPreview.addEventListener('pointerup', handlePreviewPointerUp);
  encapPreview.addEventListener('pointercancel', handlePreviewPointerCancel);
  encapPreview.addEventListener('lostpointercapture', handlePreviewPointerCancel);
  encapPreview.addEventListener('pointerleave', handlePreviewPointerLeave);
  encapPreview.addEventListener('dblclick', handlePreviewDoubleClick);
  encapPreview.addEventListener('wheel', handlePreviewWheel, { passive: false });
}
document.addEventListener('pointerdown', handleWorkbenchOutsidePointer, true);
if (encapClose) {
  encapClose.addEventListener('click', function () {
    requestCloseEncapsulationEditor();
  });
}
if (encapCloseCancel) {
  encapCloseCancel.addEventListener('click', cancelEncapCloseDialog);
}
if (encapCloseDiscard) {
  encapCloseDiscard.addEventListener('click', discardEncapCloseDialog);
}
if (encapCloseSave) {
  encapCloseSave.addEventListener('click', function () {
    void saveEncapCloseDialog();
  });
}
if (encapCloseDialog) {
  encapCloseDialog.addEventListener('pointerdown', function (event) {
    if (event.target === encapCloseDialog) {
      cancelEncapCloseDialog();
    }
  });
  encapCloseDialog.addEventListener('keydown', function (event) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEncapCloseDialog();
      return;
    }
    if (event.key === 'Tab') {
      const buttons = [encapCloseCancel, encapCloseDiscard, encapCloseSave]
        .filter(button => button && !button.disabled);
      if (!buttons.length) {
        event.preventDefault();
        return;
      }
      const current = buttons.indexOf(document.activeElement);
      const next = event.shiftKey
        ? buttons[(current <= 0 ? buttons.length : current) - 1]
        : buttons[(current + 1) % buttons.length];
      event.preventDefault();
      next.focus();
    }
  });
}
window.addEventListener('pagehide', function (event) {
  // 把 CLOCK 当前相位纳入正常 Session flush，避免刷新后回退到旧输出。
  if (session && !app.draft) {
    session.notifyCommit();
  }
  session.pagehide(event);
});
document.addEventListener('visibilitychange', function () {
  if (!document.hidden) {
    lastFrameTime = null;
    clockAccumulatorMs = 0;
  }
});
window.addEventListener('pageshow', function (event) {
  if (event.persisted) {
    session.resume();
  }
});
reducedMotion.addEventListener('change', function () { renderFrame(); });
window.addEventListener('resize', resize);
resize();

window.requestAnimationFrame(simulationFrame);

// 浏览器冒烟测试/调试入口；不参与产品逻辑。
export { app };
