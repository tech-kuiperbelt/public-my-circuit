// 封装面板：DOM 展示与控件同步。
import { rootDraftOf, draftChainOf, draftDisplayName } from "./encapsulation-model.js";
import { slotCount } from '../core/geometry.js';
import { buildNets } from '../core/nets.js';
import { bindingValue } from '../core/ports.js';
import { definitionReferenceTree } from './library.js';

// context 显式注入所需的应用对象、元素、服务与跨模块回调。
export function createPanel(context) {
  const SIDE_LABELS = { top: '上', bottom: '下', left: '左', right: '右' };

  function syncDraftPortSelectionHighlight() {
    const selectedId = context.app.selection.kind === 'port' ? context.app.selection.id : null;
    for (const row of context.encapPorts.querySelectorAll('.encap-port')) {
      row.classList.toggle('selected', row.dataset.portId === selectedId);
    }
  }

  function selectDraftPort(portId) {
    const draft = context.app.draft;
    if (!draft || !(draft.ports || []).some(function (port) { return port.id === portId; })) {
      return;
    }
    if (context.app.selection.kind === 'port' && context.app.selection.id === portId) {
      return;
    }
    context.app.setSelection({ kind: 'port', id: portId });
    context.app.render();
  }

  function renderDraftPorts() {
    const draft = context.app.draft;
    context.encapPorts.textContent = '';
    if (!draft) return;
    if (draft.ports.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'encap-hint';
      empty.textContent = '尚未标注管脚。点击“标注管脚”，再点击未连接管脚或悬空线端点。';
      context.encapPorts.appendChild(empty);
      return;
    }
    for (const port of draft.ports) {
      const row = document.createElement('div');
      row.className = 'encap-port';
      row.dataset.portId = port.id;
      row.addEventListener('pointerdown', function () {
        selectDraftPort(port.id);
      });
      row.addEventListener('focusin', function () {
        selectDraftPort(port.id);
      });

      const main = document.createElement('div');
      main.className = 'encap-port-main';
      const name = document.createElement('input');
      name.type = 'text';
      name.value = port.name;
      name.maxLength = 40;
      name.disabled = Boolean(draft.readOnly);
      name.addEventListener('change', function () {
        const value = name.value.trim();
        if (!value) {
          name.value = port.name;
          context.toast.show('管脚名称不能为空');
          return;
        }
        if (context.app.editDraftHistory) {
          context.app.editDraftHistory(() => { port.name = value; });
        } else {
          port.name = value;
        }
        syncDraftPanel();
        context.app.render();
      });
      const dir = document.createElement('span');
      dir.className = 'encap-port-dir';
      dir.textContent = port.direction === 'in' ? 'IN' : 'OUT';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = '移除';
      remove.hidden = Boolean(draft.readOnly);
      remove.addEventListener('click', function () {
        context.removeDraftPort(port.id);
      });
      main.appendChild(name);
      main.appendChild(dir);
      main.appendChild(remove);
      row.appendChild(main);

      const slotRow = document.createElement('div');
      slotRow.className = 'encap-port-slot';
      const side = document.createElement('select');
      for (const key of ['top', 'bottom', 'left', 'right']) {
        const option = document.createElement('option');
        option.value = key;
        option.textContent = SIDE_LABELS[key];
        side.appendChild(option);
      }
      side.value = port.side || 'top';
      side.disabled = Boolean(draft.readOnly);
      side.addEventListener('change', function () { context.changePortSide(port, side.value); });
      const slot = document.createElement('select');
      const count = slotCount(draft.rows, draft.cols, side.value);
      for (let i = 0; i < count; i += 1) {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = '槽 ' + i;
        slot.appendChild(option);
      }
      slot.value = String(Number.isInteger(port.slot) ? port.slot : 0);
      slot.disabled = Boolean(draft.readOnly);
      slot.addEventListener('change', function () { context.changePortSlot(port, Number(slot.value)); });
      slotRow.appendChild(side);
      slotRow.appendChild(slot);
      row.appendChild(slotRow);
      context.encapPorts.appendChild(row);
    }
    syncDraftPortSelectionHighlight();
  }

  function draftOutputValues(draft, outputs) {
    const evaluation = draft.evaluation;
    let built = null;
    const values = {};
    for (const port of outputs) {
      const binding = port && port.binding;
      const pinKey = binding && binding.kind === 'pin'
        ? binding.componentId + ':' + binding.pinId
        : null;
      if (pinKey && evaluation && evaluation.pinValue &&
          Object.prototype.hasOwnProperty.call(evaluation.pinValue, pinKey)) {
        values[port.id] = bindingValue(evaluation, null, binding);
        continue;
      }
      if (!built) {
        built = buildNets(draft.state, { definitions: draft.library, includeBarePins: true });
      }
      values[port.id] = bindingValue(evaluation, built, binding);
    }
    return values;
  }

  function createTestRow(label) {
    const row = document.createElement('div');
    row.className = 'encap-test-row';
    const tag = document.createElement('span');
    tag.className = 'encap-test-label';
    tag.textContent = label;
    const items = document.createElement('div');
    items.className = 'encap-test-items';
    row.appendChild(tag);
    row.appendChild(items);
    return { row, items };
  }

  function renderDraftTestPins() {
    const draft = context.app.draft;
    context.encapInputs.textContent = '';
    if (!draft) return;
    const inputs = draft.ports.filter(function (port) { return port.direction === 'in'; });
    const outputs = draft.ports.filter(function (port) { return port.direction === 'out'; });
    if (inputs.length === 0 && outputs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'encap-hint';
      empty.textContent = '没有管脚。';
      context.encapInputs.appendChild(empty);
      return;
    }
    if (inputs.length > 0) {
      const group = createTestRow('IN');
      for (const port of inputs) {
        const button = document.createElement('button');
        button.type = 'button';
        const value = draft.inputs[port.id] ? 1 : 0;
        button.textContent = port.name + ': ' + value;
        button.classList.toggle('on', value === 1);
        button.addEventListener('click', function () { context.toggleDraftInput(port); });
        group.items.appendChild(button);
      }
      context.encapInputs.appendChild(group.row);
    }
    if (outputs.length > 0) {
      const group = createTestRow('OUT');
      const values = draftOutputValues(draft, outputs);
      for (const port of outputs) {
        const value = values[port.id] === 1 ? 1 : 0;
        const chip = document.createElement('span');
        chip.className = 'encap-output';
        chip.dataset.portId = port.id;
        chip.dataset.value = String(value);
        chip.textContent = port.name + ': ' + value;
        chip.classList.toggle('on', value === 1);
        group.items.appendChild(chip);
      }
      context.encapInputs.appendChild(group.row);
    }
  }

  function createReferenceLabel(node) {
    const badge = document.createElement('span');
    badge.className = 'encap-ref-badge encap-ref-badge-' + (
      node.kind === 'current' ? 'current'
        : node.kind === 'session' ? 'session'
          : 'definition'
    );
    badge.textContent = node.kind === 'current' ? '当前' : (node.kind === 'session' ? '图纸' : '元件');
    const name = document.createElement('span');
    name.className = 'encap-ref-name';
    name.textContent = node.name;
    name.title = node.name;
    const label = document.createElement('span');
    label.className = 'encap-ref-label';
    label.appendChild(badge);
    label.appendChild(name);
    if (node.count > 1) {
      const count = document.createElement('span');
      count.className = 'encap-ref-count';
      count.textContent = '×' + node.count;
      label.appendChild(count);
    }
    return label;
  }

  function appendReferenceNode(parent, node) {
    const children = node.references || [];
    if (children.length === 0) {
      const leaf = document.createElement('div');
      leaf.className = 'encap-ref-leaf';
      leaf.appendChild(createReferenceLabel(node));
      parent.appendChild(leaf);
      return;
    }
    const details = document.createElement('details');
    details.className = 'encap-ref-node';
    const summary = document.createElement('summary');
    summary.appendChild(createReferenceLabel(node));
    details.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'encap-ref-children';
    for (const child of children) appendReferenceNode(list, child);
    details.appendChild(list);
    parent.appendChild(details);
  }

  function renderDraftReferences() {
    const draft = context.app.draft;
    if (!context.encapReferences || !draft) return;
    if (!context.session) {
      if (draft.referenceRenderedKey === 'no-session') return;
      draft.referenceRenderedKey = 'no-session';
      context.encapReferences.textContent = '';
      const empty = document.createElement('div');
      empty.className = 'encap-hint';
      empty.textContent = 'Session 尚未就绪。';
      context.encapReferences.appendChild(empty);
      return;
    }
    // 引用关系来自已保存的定义库与主图纸；draft.library 会排除当前定义，不能用于此树。
    // 用库/主图纸 revision 作为缓存键，避免管脚编辑或测试切换时重复扫描整个定义库。
    const status = context.session.getStatus();
    const renderedKey = [
      status.libraryReady ? 'ready' : 'loading',
      status.libraryRevision,
      status.revision,
      draft.definitionId || ''
    ].join(':');
    if (draft.referenceRenderedKey === renderedKey) return;
    draft.referenceRenderedKey = renderedKey;
    context.encapReferences.textContent = '';
    if (!draft.definitionId) {
      const empty = document.createElement('div');
      empty.className = 'encap-hint';
      empty.textContent = '保存为元件后可查看引用关系。';
      context.encapReferences.appendChild(empty);
      return;
    }
    const tree = definitionReferenceTree(
      context.session.getLibrary(),
      rootDraftOf(draft).previous.state,
      draft.definitionId
    );
    if (tree.references.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'encap-hint';
      empty.textContent = '暂无引用。';
      context.encapReferences.appendChild(empty);
      return;
    }
    const root = document.createElement('details');
    root.className = 'encap-ref-root';
    root.open = true;
    const summary = document.createElement('summary');
    summary.appendChild(createReferenceLabel(tree));
    root.appendChild(summary);
    const list = document.createElement('div');
    list.className = 'encap-ref-children';
    for (const child of tree.references) appendReferenceNode(list, child);
    root.appendChild(list);
    context.encapReferences.appendChild(root);
  }

  function syncWorkbenchCrumb(draft) {
    if (!context.encapWorkbenchCrumb) {
      return;
    }
    if (!draft) {
      context.encapWorkbenchCrumb.textContent = '主图纸 / 封装';
      return;
    }
    const names = draftChainOf(draft).map(draftDisplayName);
    context.encapWorkbenchCrumb.textContent = ['主图纸'].concat(names).join(' / ');
  }

  function syncWorkbenchHeading(draft) {
    if (!context.encapWorkbenchTitle) {
      return;
    }
    if (!draft) {
      context.encapWorkbenchTitle.textContent = '封装工作台';
      context.encapWorkbenchTitle.title = '';
      if (context.encapKind) {
        context.encapKind.textContent = '';
        context.encapKind.hidden = true;
      }
      return;
    }
    const displayName = draftDisplayName(draft);
    context.encapWorkbenchTitle.textContent = displayName;
    context.encapWorkbenchTitle.title = displayName;
    if (context.encapKind) {
      context.encapKind.hidden = Boolean(draft.readOnly);
      context.encapKind.textContent = draft.readOnly ? '' : (draft.definitionId ? '编辑中' : '新建');
    }
  }

  function resetEncapSections() {
    if (context.encapPortSection) context.encapPortSection.open = false;
    if (context.encapInputSection) context.encapInputSection.open = false;
    if (context.encapReferenceSection) context.encapReferenceSection.open = false;
  }

  function syncDraftPortButtons() {
    if (!context.encapRemovePort) {
      return;
    }
    const draft = context.app.draft;
    const hasSelectedPort = Boolean(draft &&
      context.app.selection.kind === 'port' &&
      (draft.ports || []).some(function (port) { return port.id === context.app.selection.id; }));
    const eraseMode = Boolean(draft && !draft.readOnly && context.app.mode === 'erase-port');
    context.encapRemovePort.hidden = !draft || Boolean(draft.readOnly);
    context.encapRemovePort.disabled = !draft || Boolean(draft.readOnly);
    context.encapRemovePort.classList.toggle('active', eraseMode);
    context.encapRemovePort.title = eraseMode
      ? '退出移除管脚模式'
      : hasSelectedPort ? '移除选中的管脚' : '进入移除管脚模式，点击管脚即可移除';
  }

  function syncSideTabsTop() {
    if (!context.sideTabs) {
      return;
    }
    const headerHeight = context.encapWorkbenchHeader
      ? context.encapWorkbenchHeader.offsetHeight
      : 58;
    const borderTop = context.encapWorkbench ? context.encapWorkbench.clientTop : 0;
    context.sideTabs.style.top = 'calc(var(--encap-workbench-top) + ' +
      (borderTop + headerHeight) + 'px)';
  }

  function syncDraftPanel() {
    const draft = context.app.draft;
    const open = Boolean(draft);
    context.encapPanel.hidden = !open;
    if (context.encapWorkbench) {
      context.encapWorkbench.classList.toggle('open', open);
      context.encapWorkbench.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    if (context.sideTabs) {
      context.sideTabs.classList.toggle('open', open);
    }
    if (context.encapTab) {
      context.encapTab.disabled = open;
    }
    if (context.encapBackdrop) {
      context.encapBackdrop.hidden = !open;
      if (!open) {
        context.encapBackdrop.style.backgroundImage = 'none';
      }
    }
    if (context.encapMainBlocker) {
      context.encapMainBlocker.hidden = !open;
    }
    context.canvas.classList.toggle('encap-board', open);
    if (!open) {
      if (context.iconPicker) context.iconPicker.close();
      context.canvas.classList.remove('encap-board-revealed');
      syncWorkbenchHeading(null);
      syncWorkbenchCrumb(null);
      if (context.encapMainNoteText) context.encapMainNoteText.textContent = '封装编辑中 · 暂不可操作';
      syncSideTabsTop();
      return;
    }
    const readOnly = Boolean(draft.readOnly);
    syncWorkbenchHeading(draft);
    syncWorkbenchCrumb(draft);
    if (context.encapMainNoteText) {
      context.encapMainNoteText.textContent = readOnly
        ? '封装详情中 · 暂不可操作'
        : '封装编辑中 · 暂不可操作';
    }
    if (document.activeElement !== context.encapName) context.encapName.value = draft.name;
    if (document.activeElement !== context.encapRows) context.encapRows.value = String(draft.rows);
    if (document.activeElement !== context.encapCols) context.encapCols.value = String(draft.cols);
    context.encapName.disabled = readOnly;
    context.encapRows.disabled = readOnly;
    context.encapCols.disabled = readOnly;
    if (context.encapIconTrigger) context.encapIconTrigger.disabled = readOnly;
    if (context.iconPicker) context.iconPicker.setValue(draft.icon || null);
    context.encapReadonly.hidden = !readOnly;
    context.encapAnnotate.hidden = readOnly;
    context.encapAnnotate.classList.toggle('active', !readOnly && context.app.mode === 'annotate');
    context.encapSave.hidden = readOnly;
    if (context.encapClose) {
      if (draft.parent) {
        context.encapClose.title = '返回上一层封装';
        context.encapClose.setAttribute('aria-label', '返回上一层封装');
      } else {
        context.encapClose.title = readOnly ? '关闭封装详情' : '关闭封装工作台；有修改时会提示保存';
        context.encapClose.setAttribute('aria-label', readOnly ? '关闭封装详情' : '关闭封装工作台');
      }
    }
    context.encapEdit.hidden = !readOnly || !draft.definitionId;
    context.encapEdit.disabled = readOnly && !draft.canEditDefinition;
    context.encapEdit.title = readOnly && !draft.canEditDefinition
      ? (draft.editBlockedReason || '当前不能编辑该定义')
      : '进入编辑模式';
    if (readOnly) {
      context.encapHint.textContent = draft.canEditDefinition
        ? '只读查看；可在“测试”区临时切换 IN 观察 OUT，不会保存；点击“编辑”可修改定义。'
        : '只读查看；可在“测试”区临时切换 IN 观察 OUT，不会保存；' +
          (draft.editBlockedReason || '当前不能编辑该定义') + '。';
    } else {
      context.encapHint.textContent = '画内部电路；展开“测试”可切换 IN 并查看 OUT。保存时会把所有 IN 归零并重新求值，保留内部非零记忆。';
    }
    if (context.app.selection.kind === 'port' &&
        !(draft.ports || []).some(function (port) { return port.id === context.app.selection.id; })) {
      context.app.selection = { kind: null, id: null };
    }
    syncDraftPortButtons();
    renderDraftPorts();
    renderDraftTestPins();
    renderDraftReferences();
    context.renderDraftPreview();
    syncSideTabsTop();
  }

  return { renderDraftTestPins, resetEncapSections, syncDraftPanel, syncDraftPortButtons, syncDraftPortSelectionHighlight, syncSideTabsTop, syncWorkbenchCrumb, syncWorkbenchHeading };
}
