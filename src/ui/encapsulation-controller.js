// 封装生命周期：打开、编辑、保存、关闭与工作区恢复。
import { cloneValue, draftPathHasDefinition, normalizeDraftPorts, validateDraftPorts, captureDraftBaseline, captureEditorWorkspace, restoreEditorWorkspace, draftHasChanges, createDraftDefinitionCandidate } from "./encapsulation-model.js";
import { createState } from '../core/state.js';
import { evaluateDynamic } from '../core/dynamic.js';
import { createEditHistory } from './edit-history.js';

import { definitionEditEligibility } from './library.js';
import { resolveInstanceInspection } from './instance-inspection.js';

// context 显式注入所需的应用对象、元素、服务与跨模块回调。
export function createController(context) {
  let encapCloseDialogSaving = false;

  async function openEncapsulationEditor(definitionId, options) {
    const instanceId = options && options.instanceId;
    const parentDraft = context.app.draft;
    if (parentDraft && (!definitionId || (options && options.edit))) {
      context.toast.show('请先关闭当前封装详情或编辑');
      return;
    }
    if (!context.session) {
      context.toast.show('Session 尚未就绪');
      return;
    }
    if (parentDraft && definitionId && draftPathHasDefinition(parentDraft, definitionId)) {
      context.toast.show('该定义已在当前封装路径中，不能重复打开');
      return;
    }
    if (instanceId && (!definitionId || (options && options.edit))) {
      context.toast.show('振荡现场只能只读查看');
      return;
    }
    const wantsEdit = !definitionId || Boolean(options && options.edit);
    if (wantsEdit) {
      const flushed = await context.session.flush();
      if (!flushed.ok) {
        context.toast.show('主图纸尚未保存：' + (flushed.saveError || flushed.reason || '未知错误'));
        return;
      }
    }
    const library = context.session.getLibrary();
    let inspection = null;
    let resolved = null;
    if (instanceId) {
      const instance = context.app.state.components[instanceId];
      if (!instance || instance.type !== 'CUSTOM' || instance.definitionId !== definitionId) {
        context.toast.show('封装实例与定义不匹配，无法打开现场');
        return;
      }
      resolved = resolveInstanceInspection(context.app.state, context.app.evaluation, instanceId, library);
      if (!resolved.ok) {
        context.toast.show(resolved.reason);
        return;
      }
      inspection = {
        instanceId,
        path: (parentDraft && parentDraft.inspection ? parentDraft.inspection.path : []).concat(instanceId),
        kind: resolved.kind
      };
    }
    let state;
    let evaluation;
    let ports = [];
    let rows = 1;
    let cols = 1;
    let name = '新元件';
    let icon = null;
    let inputs = {};
    let editingId = null;
    let readOnly = false;
    let canEditDefinition = true;
    let editBlockedReason = null;
    if (definitionId) {
      const definition = library.definitions[definitionId];
      if (!definition || !definition.circuit || !definition.initialEvaluation) {
        context.toast.show('定义数据不完整，无法打开');
        return;
      }
      readOnly = !wantsEdit;
      const eligibility = definitionEditEligibility(
        library,
        context.app.state,
        definitionId,
        context.session.canEdit()
      );
      canEditDefinition = eligibility.allowed;
      editBlockedReason = eligibility.reason;
      if (parentDraft && canEditDefinition) {
        canEditDefinition = false;
        editBlockedReason = '请返回主图纸后再编辑该定义';
      }
      if (!readOnly && !canEditDefinition) {
        context.toast.show(editBlockedReason || '当前不能编辑该定义');
        return;
      }
      editingId = definitionId;
      state = cloneValue(definition.circuit);
      evaluation = cloneValue(inspection ? resolved.evaluation : definition.initialEvaluation);
      ports = cloneValue(definition.ports || []);
      rows = definition.size && definition.size.rows ? definition.size.rows : 1;
      cols = definition.size && definition.size.cols ? definition.size.cols : 1;
      name = definition.name || '';
      icon = definition.icon || null;
      for (const port of ports) {
        if (port.direction === 'in') inputs[port.id] = 0;
      }
      if (inspection) {
        inputs = cloneValue(resolved.inputs);
        canEditDefinition = false;
        editBlockedReason = '振荡现场已冻结，不能编辑定义或切换输入';
      }
    } else {
      state = createState();
      evaluation = evaluateDynamic(state, undefined, undefined, { definitions: library });
    }
    if (context.input && context.input.cancel) {
      context.input.cancel();
    }
    context.resetPreviewInteraction();
    context.hidePinTooltip();
    const draftLibrary = { definitions: Object.assign({}, library.definitions) };
    if (editingId) delete draftLibrary.definitions[editingId];
    const draft = {
      history: createEditHistory(10),
      definitionId: editingId,
      name,
      icon,
      rows,
      cols,
      ports,
      inputs,
      state,
      evaluation,
      library: draftLibrary,
      readOnly,
      canEditDefinition,
      editBlockedReason,
      inspection,
      nextPortNumber: 1,
      previewZoom: 1,
      parent: parentDraft || null,
      previous: captureEditorWorkspace(context.app)
    };
    for (const port of draft.ports) {
      const match = /^p(\d+)$/.exec(port.id);
      if (match) draft.nextPortNumber = Math.max(draft.nextPortNumber, Number(match[1]) + 1);
    }
    normalizeDraftPorts(draft);
    draft.baseline = captureDraftBaseline(draft);
    if (!parentDraft) {
      context.captureWorkbenchSnapshot();
    }
    context.app.draft = draft;
    context.app.state = draft.state;
    context.app.evaluation = draft.evaluation;
    context.app.selection = { kind: null, id: null };
    context.app.mode = 'select';
    context.app.placeType = null;
    context.app.placeDefinitionId = null;
    context.app.tool = null;
    for (const key of Object.keys(context.app.overlay)) context.app.overlay[key] = null;
    context.componentBar.setDefinitions(draft.library);
    if (context.componentBar.setHiddenTypes) context.componentBar.setHiddenTypes(['CLOCK']);
    context.componentBar.setActive(null);
    context.toolBar.setActive(null);
    context.syncDraftPanel();
    context.app.view = context.draftInitialView(draft);
    context.updateCursor();
    context.updatePlacementHint();
    context.updateRuntimeStatus();
    context.app.render();
    if (parentDraft) {
      context.clearWorkbenchPreview();
      context.revealWorkbenchCanvas();
    } else {
      context.startWorkbenchPreview();
    }
    // Ctrl/Cmd+点击「封装电路」时，主图纸选择已提前拍成复制快照；
    // 工作台初始化完成后在内部图纸继续复制放置流程。
    if (!definitionId && options && options.copySnapshot &&
        context.input && context.input.startCopySnapshot) {
      context.input.startCopySnapshot(options.copySnapshot);
    }
  }

  async function switchEncapsulationToEdit() {
    const draft = context.app.draft;
    if (draft && draft.inspection) {
      context.toast.show('振荡现场已冻结，不能进入编辑模式');
      return;
    }
    if (!draft || !draft.readOnly || !draft.definitionId || !context.session) {
      return;
    }
    if (!context.session.canEdit()) {
      draft.canEditDefinition = false;
      draft.editBlockedReason = '当前页面没有编辑权';
      context.toast.show(draft.editBlockedReason);
      context.syncDraftPanel();
      return;
    }
    const flushed = await context.session.flush();
    if (!flushed.ok) {
      context.toast.show('主图纸尚未保存：' + (flushed.saveError || flushed.reason || '未知错误'));
      return;
    }
    const library = context.session.getLibrary();
    const definition = library.definitions[draft.definitionId];
    if (!definition || !definition.circuit || !definition.initialEvaluation) {
      draft.canEditDefinition = false;
      draft.editBlockedReason = '定义数据不完整';
      context.toast.show('定义数据不完整，无法编辑');
      context.syncDraftPanel();
      return;
    }
    const eligibility = definitionEditEligibility(
      library,
      draft.previous.state,
      draft.definitionId,
      context.session.canEdit()
    );
    draft.canEditDefinition = eligibility.allowed;
    draft.editBlockedReason = eligibility.reason;
    if (!eligibility.allowed) {
      context.toast.show(eligibility.reason || '当前不能编辑该定义');
      context.syncDraftPanel();
      return;
    }
    draft.readOnly = false;
    draft.history = createEditHistory(10);
    draft.editBlockedReason = null;
    draft.state = cloneValue(definition.circuit);
    draft.evaluation = cloneValue(definition.initialEvaluation);
    draft.ports = cloneValue(definition.ports || []);
    draft.rows = definition.size && definition.size.rows ? definition.size.rows : 1;
    draft.cols = definition.size && definition.size.cols ? definition.size.cols : 1;
    draft.name = definition.name || '';
    draft.icon = definition.icon || null;
    draft.inputs = {};
    for (const port of draft.ports) {
      if (port.direction === 'in') draft.inputs[port.id] = 0;
    }
    draft.library = { definitions: Object.assign({}, library.definitions) };
    delete draft.library.definitions[draft.definitionId];
    normalizeDraftPorts(draft);
    draft.baseline = captureDraftBaseline(draft);
    context.app.state = draft.state;
    context.app.evaluation = draft.evaluation;
    context.componentBar.setDefinitions(draft.library);
    if (context.componentBar.setHiddenTypes) context.componentBar.setHiddenTypes(['CLOCK']);
    context.componentBar.setActive(null);
    context.syncDraftPanel();
    context.clearWorkbenchPreview();
    context.revealWorkbenchCanvas();
    context.updateRuntimeStatus();
    context.app.render();
    context.toast.show('已进入编辑模式');
  }

  function resetEncapCloseDialogButtons() {
    if (context.encapCloseSave) {
      context.encapCloseSave.textContent = '保存并关闭';
    }
    [context.encapCloseCancel, context.encapCloseDiscard, context.encapCloseSave].forEach(function (button) {
      if (button) button.disabled = false;
    });
  }

  function hideEncapCloseDialog(options) {
    if (!context.encapCloseDialog) {
      return;
    }
    context.encapCloseDialog.hidden = true;
    resetEncapCloseDialogButtons();
    if (options && options.restoreFocus && context.encapClose) {
      context.encapClose.focus();
    }
  }

  function showEncapCloseDialog() {
    if (!context.encapCloseDialog) {
      return;
    }
    resetEncapCloseDialogButtons();
    context.encapCloseDialog.hidden = false;
    if (context.encapCloseCancel) {
      context.encapCloseCancel.focus();
    }
  }

  function cancelEncapCloseDialog() {
    if (encapCloseDialogSaving) {
      return;
    }
    hideEncapCloseDialog({ restoreFocus: true });
  }

  function discardEncapCloseDialog() {
    if (encapCloseDialogSaving) {
      return;
    }
    hideEncapCloseDialog();
    closeEncapsulationEditor();
  }

  async function saveEncapCloseDialog() {
    if (encapCloseDialogSaving) {
      return;
    }
    encapCloseDialogSaving = true;
    if (context.encapCloseCancel) context.encapCloseCancel.disabled = true;
    if (context.encapCloseDiscard) context.encapCloseDiscard.disabled = true;
    if (context.encapCloseSave) {
      context.encapCloseSave.disabled = true;
      context.encapCloseSave.textContent = '保存中…';
    }
    try {
      await saveEncapsulationEditor();
    } finally {
      encapCloseDialogSaving = false;
      if (context.encapCloseDialog && !context.encapCloseDialog.hidden) {
        hideEncapCloseDialog({ restoreFocus: true });
      } else {
        resetEncapCloseDialogButtons();
      }
    }
  }

  function requestCloseEncapsulationEditor() {
    const draft = context.app.draft;
    if (!draft) {
      return;
    }
    if (!draft.readOnly && draftHasChanges(draft, context.encapName ? context.encapName.value.trim() : draft.name)) {
      showEncapCloseDialog();
      return;
    }
    closeEncapsulationEditor();
  }

  function restoreParentDraft(draft) {
    const parent = draft.parent;
    const previous = draft.previous;
    context.app.draft = parent;
    restoreEditorWorkspace(context.app, previous);
    context.componentBar.setDefinitions(parent.library);
    if (context.componentBar.setHiddenTypes) context.componentBar.setHiddenTypes(['CLOCK']);
    context.componentBar.setActive(
      context.app.mode === 'place' ? context.app.placeType : null,
      context.app.placeDefinitionId
    );
    context.toolBar.setActive(context.app.mode === 'select' ? null : context.app.tool);
    context.syncDraftPanel();
    context.updateCursor();
    context.updatePlacementHint();
    context.updateRuntimeStatus();
    context.app.render();
  }

  function closeEncapsulationEditor() {
    const draft = context.app.draft;
    if (!draft) return;
    if (context.iconPicker) context.iconPicker.close();
    hideEncapCloseDialog();
    context.resetPreviewInteraction();
    if (context.input && context.input.cancel) context.input.cancel();
    context.hidePinTooltip();
    if (draft.parent) {
      restoreParentDraft(draft);
      return;
    }
    context.clearWorkbenchPreview();
    context.app.draft = null;
    restoreEditorWorkspace(context.app, draft.previous);
    context.componentBar.setDefinitions(context.app.library);
    if (context.componentBar.setHiddenTypes) context.componentBar.setHiddenTypes([]);
    context.componentBar.setActive(
      context.app.mode === 'place' ? context.app.placeType : null,
      context.app.placeDefinitionId
    );
    context.toolBar.setActive(context.app.mode === 'select' ? null : context.app.tool);
    context.syncDraftPanel();
    context.updateCursor();
    context.updatePlacementHint();
    context.updateRuntimeStatus();
    context.app.render();
  }

  function generateDefinitionId() {
    const base = 'u' + Date.now().toString(36);
    let id = base;
    let suffix = 0;
    while (context.app.library.definitions[id]) {
      suffix += 1;
      id = base + '-' + suffix;
    }
    return id;
  }

  async function saveEncapsulationEditor() {
    const draft = context.app.draft;
    if (!draft) return;
    if (draft.inspection) {
      context.toast.show('振荡现场已冻结，不能保存');
      return;
    }
    if (draft.readOnly) {
      context.toast.show('只读详情不能保存；请先点击“编辑”');
      return;
    }
    const name = (context.encapName.value || '').trim();
    if (!name) {
      context.toast.show('请填写定义名称');
      return;
    }
    draft.name = name;
    const hasClock = Object.values(draft.state.components || {}).some(function (component) {
      return component && component.type === 'CLOCK';
    });
    if (hasClock) {
      context.toast.show('封装电路暂不支持 CLOCK；请先从内部电路移除');
      return;
    }
    const layout = validateDraftPorts(draft);
    if (!layout.ok) {
      context.toast.show(layout.reason);
      return;
    }
    const zeroInputs = draft.ports.filter(function (port) {
      return port.direction === 'in';
    }).map(function (port) {
      return { portId: port.id, binding: port.binding, value: 0 };
    });
    const initial = evaluateDynamic(draft.state, draft.evaluation, undefined, {
      definitions: draft.library,
      includeBarePins: true,
      externalInputs: zeroInputs
    });
    if (!initial.ok) {
      context.toast.show('初态求值失败：' + (initial.reason || '未知错误'));
      return;
    }
    if (initial.status !== 'stable' || (initial.pending && initial.pending.length > 0)) {
      context.toast.show('当前电路不是 stable，不能保存定义');
      return;
    }
    const isNew = !draft.definitionId;
    const candidate = createDraftDefinitionCandidate(
      draft, draft.definitionId || generateDefinitionId(), name, initial
    );
    context.encapSave.disabled = true;
    const previousText = context.encapSave.textContent;
    context.encapSave.textContent = '校验中…';
    try {
      const result = draft.definitionId
        ? await context.session.updateDefinition(candidate)
        : await context.session.createDefinition(candidate);
      if (!result.ok) {
        context.toast.show(context.formatLibraryError(result));
        return;
      }
      context.toast.show(draft.definitionId ? '定义已更新' : '定义已保存');
      if (context.onDefinitionSaved) {
        context.onDefinitionSaved(result.definition || candidate, isNew);
      }
      closeEncapsulationEditor();
    } finally {
      context.encapSave.disabled = false;
      context.encapSave.textContent = previousText;
    }
  }

  async function deleteDefinitionFromBar(definitionId) {
    if (context.app.draft) {
      context.toast.show(context.app.draft.readOnly ? '请先关闭封装详情' : '请先保存或取消封装编辑');
      return;
    }
    if (!context.session) return;
    const result = await context.session.deleteDefinition(definitionId);
    if (result.ok) {
      context.toast.show('定义已删除');
    } else {
      context.toast.show(context.formatLibraryError(result));
    }
  }

  return { cancelEncapCloseDialog, closeEncapsulationEditor, deleteDefinitionFromBar, discardEncapCloseDialog, openEncapsulationEditor, requestCloseEncapsulationEditor, saveEncapCloseDialog, saveEncapsulationEditor, switchEncapsulationToEdit };
}
