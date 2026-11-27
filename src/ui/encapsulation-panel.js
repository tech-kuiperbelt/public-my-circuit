// 封装面板：DOM 展示与控件同步。
import { rootDraftOf, draftChainOf, draftDisplayName, draftTestValues } from "./encapsulation-model.js";
import { slotCount, slotOffset } from '../core/geometry.js';
import { definitionReferenceTree } from './library.js';

const PORT_LIST_SIDES = ['left', 'right', 'top', 'bottom'];
const NUMBERED_TEST_PORT = /^([a-z]+)\d+$/i;
const compareTestPortNames = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

function portsInPreviewOrder(draft) {
  return draft.ports.map(port => {
    // 交界槽位的编号追加在末尾，列表顺序以实际坐标为准。
    const point = slotOffset(draft.rows, draft.cols, port.side, port.slot);
    if (!point) return { port, edge: PORT_LIST_SIDES.length, position: 0 };
    const edge = PORT_LIST_SIDES.indexOf(port.side);
    const position = port.side === 'left' || port.side === 'right' ? point.y : point.x;
    return { port, edge, position };
  }).sort((a, b) => a.edge - b.edge || a.position - b.position)
    .map(entry => entry.port);
}

function testPortGroups(ports) {
  const groups = [];
  let current = null;
  for (const port of ports) {
    const prefix = NUMBERED_TEST_PORT.exec(port.name)?.[1].toUpperCase() ?? null;
    if (!current || current.prefix !== prefix) {
      current = { prefix, ports: [] };
      groups.push(current);
    }
    current.ports.push(port);
  }
  return groups.map(({ prefix, ports: groupPorts }) => {
    if (prefix) {
      groupPorts.sort((a, b) => compareTestPortNames(b.name, a.name));
    }
    return groupPorts;
  });
}

// context 显式注入所需的应用对象、元素、服务与跨模块回调。
export function createPanel(context) {
  const SIDE_LABELS = { top: '上', bottom: '下', left: '左', right: '右' };
  let renderedTestDraft = null;
  let renderedTestLayout = null;
  const testPins = new Map();
  let renderedReferenceDraft = null;
  let renderedReferenceKey = null;

  function syncDraftPortSelectionHighlight() {
    const selectedId = context.app.selection.kind === 'port' ? context.app.selection.id : null;
    for (const row of context.encapPorts.querySelectorAll('.encap-port')) {
      row.classList.toggle('selected', row.dataset.portId === selectedId);
    }
  }

  function revealDraftPort(portId) {
    const { encapPanel, encapPortSection, encapPorts, encapPreviewHeader } = context;
    const selection = context.app.selection;
    if (encapPortSection.hidden || selection.kind !== 'port' || selection.id !== portId) return;
    const row = Array.from(encapPorts.children).find(item => item.dataset.portId === portId);
    if (!row) return;

    const sticky = encapPreviewHeader.getClientRects().length
      ? encapPreviewHeader : encapPreviewHeader.querySelector('#encap-preview-tabs');
    const header = sticky.getBoundingClientRect();
    const panelTop = encapPanel.getBoundingClientRect().top + encapPanel.clientTop;
    const panelBottom = panelTop + encapPanel.clientHeight;
    const bounds = row.getBoundingClientRect();
    if (bounds.top >= header.bottom && bounds.bottom <= panelBottom) return;

    // 滚动后预览和标签可能吸顶，将管脚行放到整个区域下方。
    const pinnedBottom = panelTop + header.height;
    const gap = Math.min(8, Math.max(0, Math.floor(panelBottom - pinnedBottom - bounds.height)));
    encapPanel.scrollTop += bounds.top - (pinnedBottom + gap);
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
      empty.textContent = '尚未标注管脚。点击“标注管脚”，再点击元件管脚或悬空线端点。';
      context.encapPorts.appendChild(empty);
      return;
    }
    for (const port of portsInPreviewOrder(draft)) {
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

  function createTestRow(label) {
    const row = document.createElement('div');
    row.className = 'encap-test-row';
    const tag = document.createElement('span');
    tag.className = 'encap-test-label';
    tag.textContent = label;
    const items = document.createElement('div');
    items.className = 'encap-test-groups';
    row.appendChild(tag);
    row.appendChild(items);
    return { row, items };
  }

  function createTestPin(port, group) {
    const isInput = port.direction === 'in';
    const pin = document.createElement(isInput ? 'button' : 'span');
    pin.dataset.portId = port.id;
    group.appendChild(pin);
    const note = isInput ? document.createElement('span') : null;
    if (note) {
      note.className = 'encap-hint encap-test-pause-reason';
      group.appendChild(note);
      pin.type = 'button';
      pin.addEventListener('click', () => {
        if (!pin.disabled) context.toggleDraftInput(port.id);
      });
    } else {
      pin.className = 'encap-output';
    }
    testPins.set(port.id, { pin, note });
  }

  function rebuildTestList(draft) {
    context.encapInputs.textContent = '';
    testPins.clear();
    if (draft.ports.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'encap-hint';
      empty.textContent = '没有管脚。';
      context.encapInputs.appendChild(empty);
      return;
    }
    const ordered = portsInPreviewOrder(draft);
    for (const [direction, label] of [['in', 'IN'], ['out', 'OUT']]) {
      const ports = ordered.filter(port => port.direction === direction);
      if (ports.length === 0) continue;
      const { row, items } = createTestRow(label);
      for (const group of testPortGroups(ports)) {
        const pins = document.createElement('div');
        pins.className = 'encap-test-items';
        for (const port of group) createTestPin(port, pins);
        items.appendChild(pins);
      }
      context.encapInputs.appendChild(row);
    }
  }

  function renderDraftTestPins() {
    const draft = context.app.draft;
    if (!draft) return;
    const layout = JSON.stringify([draft.rows, draft.cols, draft.ports.map(port =>
      [port.id, port.name, port.direction, port.side, port.slot])]);
    if (draft !== renderedTestDraft || layout !== renderedTestLayout) {
      rebuildTestList(draft);
      renderedTestDraft = draft;
      renderedTestLayout = layout;
    }
    const { inputs, outputs, pausedInputs } = draftTestValues(draft);
    for (const port of draft.ports) {
      const { pin, note } = testPins.get(port.id);
      const reason = Object.hasOwn(pausedInputs, port.id) ? pausedInputs[port.id] : '';
      const value = reason ? '—' : (note ? inputs[port.id] : outputs[port.id]);
      const text = port.name + ': ' + value;
      if (pin.textContent !== text) pin.textContent = text;
      pin.dataset.value = String(value);
      pin.classList.toggle('on', value === 1);
      if (note) {
        pin.disabled = Boolean(draft.inspection || reason);
        pin.title = reason || (draft.inspection ? '振荡现场输入已冻结' : '');
        note.hidden = !reason;
        if (note.textContent !== reason) note.textContent = reason;
      }
    }
  }

  function createReferenceLabel(node) {
    const badge = document.createElement('span');
    badge.className = 'encap-ref-badge encap-ref-badge-' + node.kind;
    badge.textContent = node.kind === 'session' ? '图纸' : '元件';
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
    // 引用关系来自已保存的定义库与主图纸；draft.library 会排除当前定义，不能用于此树。
    // 引用树共用一个容器，切换草稿时需要重新渲染。
    const session = context.session;
    const status = session?.getStatus();
    const renderedKey = status ? [
      status.libraryReady ? 'ready' : 'loading',
      status.libraryRevision,
      status.revision,
      draft.definitionId || ''
    ].join(':') : 'no-session';
    if (draft === renderedReferenceDraft && renderedKey === renderedReferenceKey) return;
    renderedReferenceDraft = draft;
    renderedReferenceKey = renderedKey;
    context.encapReferences.textContent = '';
    if (!session || !draft.definitionId) {
      const empty = document.createElement('div');
      empty.className = 'encap-hint';
      empty.textContent = session ? '保存为元件后可查看引用关系。' : 'Session 尚未就绪。';
      context.encapReferences.appendChild(empty);
      return;
    }
    const tree = definitionReferenceTree(
      session.getLibrary(),
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
    for (const child of tree.references) appendReferenceNode(context.encapReferences, child);
  }

  function syncWorkbenchCrumb(draft) {
    if (!context.encapWorkbenchCrumb) {
      return;
    }
    if (!draft) {
      context.encapWorkbenchCrumb.textContent = '主图纸 / 封装';
      context.encapWorkbenchCrumb.title = '';
      return;
    }
    const names = draftChainOf(draft).map(function (item) {
      return draftDisplayName(item) + (item.inspection ? '（' + item.inspection.instanceId + '）' : '');
    });
    context.encapWorkbenchCrumb.textContent = ['主图纸'].concat(names).join(' / ');
    context.encapWorkbenchCrumb.title = draft.inspection
      ? '实例路径：' + draft.inspection.path.join(' / ') : '';
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
    context.encapWorkbenchTitle.textContent = displayName + (draft.inspection ? ' · 振荡现场' : '');
    context.encapWorkbenchTitle.title = displayName;
    if (context.encapKind) {
      context.encapKind.hidden = Boolean(draft.readOnly) && !draft.inspection;
      context.encapKind.textContent = draft.inspection ? '冻结现场' : draft.readOnly ? '' : (draft.definitionId ? '编辑中' : '新建');
    }
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
      renderedTestDraft = null;
      renderedTestLayout = null;
      testPins.clear();
      context.encapInputs.textContent = '';
      renderedReferenceDraft = null;
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
        ? draft.inspection ? '振荡现场中 · 原图纸暂不可操作' : '封装详情中 · 暂不可操作'
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
    context.encapEdit.hidden = Boolean(draft.inspection) || !readOnly || !draft.definitionId;
    context.encapEdit.disabled = Boolean(draft.inspection) || (readOnly && !draft.canEditDefinition);
    context.encapEdit.title = readOnly && !draft.canEditDefinition
      ? (draft.editBlockedReason || '当前不能编辑该定义')
      : '进入编辑模式';
    if (draft.inspection) {
      const sceneHint = draft.inspection.kind === 'outer-feedback'
        ? '内部当前稳定，振荡反馈在上一层；OUT 为内部已提交状态。'
        : '显示本次内部振荡尝试；OUT 为现场值，尚未向上一层提交。';
      context.encapHint.textContent = sceneHint + '现场只读，IN 已冻结，不能编辑或保存；可右键红色封装“详细”继续逐层定位。' +
        '实例路径：' + draft.inspection.path.join(' / ') + '。';
    } else if (readOnly) {
      context.encapHint.textContent = draft.canEditDefinition
        ? '只读查看；可在“测试”区临时切换 IN 观察 OUT，不会保存；点击“编辑”可修改定义。'
        : '只读查看；可在“测试”区临时切换 IN 观察 OUT，不会保存；' +
          (draft.editBlockedReason || '当前不能编辑该定义') + '。';
    } else {
      context.encapHint.textContent = '画内部电路；切到“测试”可切换 IN 并查看 OUT。保存时会把所有 IN 归零并重新求值，保留内部非零记忆。';
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

  return { renderDraftTestPins, revealDraftPort, syncDraftPanel, syncDraftPortButtons, syncDraftPortSelectionHighlight, syncSideTabsTop, syncWorkbenchCrumb, syncWorkbenchHeading };
}
