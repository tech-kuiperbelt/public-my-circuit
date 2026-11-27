// 职责：左侧元件栏底部的“箱子”面板。
// 箱子按 tab 分页，每页固定 10 行 × 16 列；系统元件在“系统”页且不可删除，
// 自定义元件从第 2 页开始。从箱子拖到左侧元件栏即可固定该元件。
import { resolveComponentDropTarget } from './component-drop-target.js';
import { BOX_PAGE_SIZE } from './component-inventory.js';

// 简笔线稿箱子：关闭时盖子合上，打开时盖子抬起并露出深色箱口。
const BOX_CLOSED_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M4 12V9a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v3"></path>
  <path d="M4 12h16v7a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-7Z"></path>
  <rect x="10" y="10.5" width="4" height="4.5" rx="0.8"></rect>
  <path d="M11.2 12.2h1.6"></path>
  <path d="M6 20v1M18 20v1"></path>
</svg>`.trim();

const BOX_OPEN_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M5 8V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v2"></path>
  <path d="M4 11h16v9a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-9Z"></path>
  <path d="M5 11h14v3H5z" fill="#000" opacity="0.45" stroke="none"></path>
  <path d="M4 14h16"></path>
  <rect x="10" y="12.5" width="4" height="4.5" rx="0.8"></rect>
  <path d="M11.2 14.2h1.6"></path>
  <path d="M6 20v1M18 20v1"></path>
</svg>`.trim();

const DRAG_THRESHOLD = 4;

export function createComponentBox(options) {
  const opts = options || {};
  const doc = opts.document || document;
  const toggle = opts.toggle || doc.getElementById('component-box-toggle');
  const panel = opts.panel || doc.getElementById('component-box');
  const tabs = opts.tabs || doc.getElementById('component-box-tabs');
  const tabsPrev = opts.tabsPrev || doc.getElementById('component-box-tabs-prev');
  const tabsNext = opts.tabsNext || doc.getElementById('component-box-tabs-next');
  const page = opts.page || doc.getElementById('component-box-page');

  if (!toggle || !panel || !tabs || !page) {
    return {
      refresh: function () {},
      setOpen: function () {},
      setActive: function () {},
      isOpen: function () { return false; },
      containsPoint: function () { return false; },
      getInventory: function () { return null; }
    };
  }

  if (!toggle.innerHTML.trim()) {
    toggle.innerHTML = BOX_CLOSED_ICON;
  }

  let open = false;
  let activePage = 0;
  let activeType = null;
  let activeDefinitionId = null;
  let dragCleanup = null;
  let tabsResizeObserver = null;
  let seenTimer = null;
  let scheduledKey = null;

  const inventory = opts.getInventory;

  function pendingKey() {
    return opts.getPendingItem ? opts.getPendingItem() : null;
  }

  function canMarkSeen() {
    return !opts.canMarkSeen || opts.canMarkSeen();
  }

  function clearSeenTimer() {
    if (seenTimer !== null) {
      window.clearTimeout(seenTimer);
      seenTimer = null;
    }
    scheduledKey = null;
  }

  function scheduleSeen(key) {
    if (!key) {
      return;
    }
    clearSeenTimer();
    scheduledKey = key;
    seenTimer = window.setTimeout(function () {
      seenTimer = null;
      const scheduled = scheduledKey;
      scheduledKey = null;
      if (!open || !canMarkSeen()) {
        return;
      }
      if (opts.onPendingItemSeen) {
        opts.onPendingItemSeen(scheduled);
      }
      render();
      updateNotifyIndicator();
    }, 2200);
  }

  function focusPendingItem(inv, key) {
    const pageInfo = inv.pages.find(function (pageInfo) {
      return pageInfo.cells.some(function (item) {
        return item && item.key === key;
      });
    });
    if (!pageInfo) {
      clearSeenTimer();
      if (opts.onPendingItemSeen) {
        opts.onPendingItemSeen(key);
      }
      return false;
    }
    activePage = pageInfo.index;
    return true;
  }

  function updateToggleIcon() {
    toggle.innerHTML = open ? BOX_OPEN_ICON : BOX_CLOSED_ICON;
    toggle.dataset.state = open ? 'open' : 'closed';
    toggle.title = open ? '箱子（已打开，再次点击关闭）' : '箱子（点击打开，管理元件）';
    toggle.setAttribute('aria-label', open ? '箱子（已打开）' : '箱子（已关闭）');
  }

  function updateNotifyIndicator() {
    toggle.classList.toggle('box-notify', Boolean(pendingKey()));
  }

  function updateTabScrollState() {
    if (!tabsPrev || !tabsNext) {
      return;
    }
    const maxScroll = Math.max(0, tabs.scrollWidth - tabs.clientWidth);
    const hasOverflow = maxScroll > 1;
    if (tabsPrev.hidden === hasOverflow) {
      tabsPrev.hidden = !hasOverflow;
      tabsNext.hidden = !hasOverflow;
      if (hasOverflow && typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(updateTabScrollState);
      }
    }
    if (!hasOverflow) {
      return;
    }
    tabsPrev.disabled = tabs.scrollLeft <= 1;
    tabsNext.disabled = tabs.scrollLeft >= maxScroll - 1;
  }

  function scrollTabs(direction) {
    const amount = Math.max(80, Math.floor(tabs.clientWidth * 0.8));
    tabs.scrollLeft += direction * amount;
    updateTabScrollState();
  }

  function isActiveItem(item) {
    if (!activeType || !item || item.type !== activeType) {
      return false;
    }
    return item.type !== 'CUSTOM' ||
      (item.definitionId || null) === (activeDefinitionId || null);
  }

  function applyActiveClasses() {
    const cells = page.querySelectorAll('.box-cell[data-item-key]');
    for (const cell of cells) {
      const isActive = Boolean(activeType) && cell.dataset.type === activeType &&
        (activeType !== 'CUSTOM' ||
          (cell.dataset.definitionId || null) === (activeDefinitionId || null));
      cell.classList.toggle('box-cell-active', isActive);
    }
  }

  function toolbarElement() {
    return doc.getElementById('components');
  }

  function dropTarget(clientX, clientY) {
    return resolveComponentDropTarget(doc, clientX, clientY);
  }

  function cancelDrag() {
    if (dragCleanup) {
      dragCleanup();
    }
  }

  function startDrag(item, event) {
    if (typeof event.button === 'number' && event.button !== 0) {
      return;
    }
    event.preventDefault();
    cancelDrag();

    const ctrl = Boolean(event.ctrlKey || event.metaKey);
    if (!(ctrl && opts.isActive && opts.isActive(item))) {
      if (opts.onActivate) {
        opts.onActivate(item, event);
      }
    }

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let ghost = null;
    let hoverCell = null;
    let hoverTab = null;

    function removeGhost() {
      if (ghost && ghost.parentNode) {
        ghost.parentNode.removeChild(ghost);
      }
      ghost = null;
      const bar = toolbarElement();
      if (bar) {
        bar.classList.remove('box-drop-target');
      }
    }

    function clearHoverCell() {
      if (hoverCell) {
        hoverCell.classList.remove('box-cell-drop-target');
        hoverCell = null;
      }
    }

    function setHoverCell(cell) {
      if (hoverCell === cell) {
        return;
      }
      clearHoverCell();
      hoverCell = cell;
      if (hoverCell) {
        hoverCell.classList.add('box-cell-drop-target');
      }
    }

    function clearHoverTab() {
      if (hoverTab) {
        hoverTab.classList.remove('box-tab-drop-target');
        hoverTab = null;
      }
    }

    function setHoverTab(tab) {
      if (hoverTab === tab) {
        return;
      }
      clearHoverTab();
      hoverTab = tab;
      if (hoverTab) {
        hoverTab.classList.add('box-tab-drop-target');
      }
    }

    function cleanup() {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      clearHoverCell();
      clearHoverTab();
      removeGhost();
      dragCleanup = null;
    }

    function createGhost(clientX, clientY) {
      ghost = doc.createElement('div');
      ghost.className = 'box-drag-ghost';
      if (item.icon) {
        ghost.innerHTML = item.icon;
      } else {
        ghost.textContent = item.label;
      }
      doc.body.appendChild(ghost);
      moveGhost(clientX, clientY);
    }

    function moveGhost(clientX, clientY) {
      if (!ghost) {
        return;
      }
      ghost.style.left = (clientX + 8) + 'px';
      ghost.style.top = (clientY + 8) + 'px';
    }

    function onMove(moveEvent) {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      if (!moved &&
          Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD &&
          Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD) {
        return;
      }
      moved = true;
      if (!ghost) {
        createGhost(moveEvent.clientX, moveEvent.clientY);
      } else {
        moveGhost(moveEvent.clientX, moveEvent.clientY);
      }
      const target = dropTarget(moveEvent.clientX, moveEvent.clientY);
      const overToolbar = target.kind === 'toolbar';
      const targetCell = target.kind === 'cell' ? target.element : null;
      const targetTab = target.kind === 'tab' && item.kind === 'custom' ? target.element : null;
      const bar = toolbarElement();
      if (bar) {
        bar.classList.toggle('box-drop-target', overToolbar && (!opts.canPin || opts.canPin(item)));
      }
      setHoverCell(targetCell);
      setHoverTab(targetTab);
    }

    function onUp(upEvent) {
      if (upEvent.pointerId !== pointerId) {
        return;
      }
      const target = moved ? dropTarget(upEvent.clientX, upEvent.clientY) : { kind: 'none' };
      const overToolbar = target.kind === 'toolbar';
      const targetCellElement = target.kind === 'cell' ? target.element : null;
      const targetTabElement = target.kind === 'tab' && item.kind === 'custom' ? target.element : null;
      const overCanvas = target.kind === 'canvas' &&
        (!opts.isOverCanvas || opts.isOverCanvas(upEvent.clientX, upEvent.clientY));
      const targetPage = targetCellElement
        ? Number(targetCellElement.dataset.page)
        : targetTabElement
          ? Number(targetTabElement.dataset.page)
          : null;
      const targetCell = targetCellElement ? Number(targetCellElement.dataset.cell) : null;
      const targetKey = targetCellElement ? targetCellElement.dataset.itemKey || null : null;
      cleanup();
      if (overToolbar && opts.onPin) {
        opts.onPin(item);
        return;
      }
      if (targetCellElement && targetKey !== item.key && opts.onMove) {
        opts.onMove(item, targetPage, targetCell);
        return;
      }
      if (targetTabElement && opts.onMoveToTab) {
        const movedToTab = opts.onMoveToTab(item, targetPage);
        if (movedToTab) {
          activePage = targetPage;
          render();
        }
        return;
      }
      if (overCanvas && opts.onPlace) {
        opts.onPlace(item, upEvent.clientX, upEvent.clientY, upEvent.ctrlKey || upEvent.metaKey);
      }
    }

    function onCancel() {
      cleanup();
    }

    dragCleanup = cleanup;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  let tabStructure = null;
  let pageSignature = null;
  function renderTabs(inv) {
    const structure = JSON.stringify(inv.pages.map(p => [p.index, p.kind, p.items.length === 0]));
    if (tabStructure === structure) {
      for (const button of tabs.querySelectorAll('.box-tab[data-page]')) {
        const info = inv.pages[Number(button.dataset.page)];
        button.textContent = info.label;
        button.title = info.label + '（' + info.items.length + ' 个元件）' +
          (info.kind === 'custom' ? '；双击重命名页签' : '');
        button.setAttribute('aria-selected', String(info.index === activePage));
      }
      updateTabScrollState();
      return;
    }
    tabStructure = structure;
    tabs.textContent = '';
    for (const pageInfo of inv.pages) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'box-tab';
      button.textContent = pageInfo.label;
      button.dataset.page = String(pageInfo.index);
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-selected', String(pageInfo.index === activePage));
      button.title = pageInfo.label + '（' + pageInfo.items.length + ' 个元件）' +
        (pageInfo.kind === 'custom' ? '；双击重命名页签' : '');
      button.addEventListener('click', function () {
        activePage = pageInfo.index;
        render();
      });
      let tabContainer = button;
      if (pageInfo.kind === 'custom') {
        button.addEventListener('dblclick', function (event) {
          event.preventDefault();
          if (opts.onRenameTab) {
            opts.onRenameTab(pageInfo.index, button.textContent);
          }
        });
        tabContainer = doc.createElement('span');
        tabContainer.className = 'box-tab-group';
        tabContainer.appendChild(button);
        if (pageInfo.items.length === 0) {
          const removeButton = doc.createElement('span');
          removeButton.className = 'box-tab-delete';
          removeButton.textContent = '×';
          removeButton.title = '删除空页签';
          removeButton.setAttribute('role', 'button');
          removeButton.setAttribute('aria-label', '删除空页签');
          removeButton.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            if (!opts.onDeleteTab) {
              return;
            }
            const previousActivePage = activePage;
            const deleted = opts.onDeleteTab(pageInfo.index);
            if (deleted === false) {
              return;
            }
            activePage = previousActivePage >= pageInfo.index
              ? Math.max(0, previousActivePage - 1) : previousActivePage;
            render();
          });
          removeButton.addEventListener('dblclick', function (event) {
            event.preventDefault();
            event.stopPropagation();
          });
          tabContainer.appendChild(removeButton);
        }
      }
      tabs.appendChild(tabContainer);
    }

    const addButton = doc.createElement('button');
    addButton.type = 'button';
    addButton.className = 'box-tab box-tab-add';
    addButton.textContent = '+';
    addButton.title = '新增自定义页签';
    addButton.setAttribute('aria-label', '新增自定义页签');
    addButton.addEventListener('click', function (event) {
      event.preventDefault();
      const nextPage = inventory().pages.length;
      const addedPage = opts.onAddTab ? opts.onAddTab() : undefined;
      activePage = Number.isInteger(addedPage) ? addedPage : nextPage;
      render();
    });
    tabs.appendChild(addButton);
    updateTabScrollState();
  }

  function renderPage(inv) {
    const signature = JSON.stringify([activePage, inv.pages[activePage], Array.from(inv.toolbarKeys), pendingKey()]);
    if (signature === pageSignature) {
      applyActiveClasses();
      return;
    }
    pageSignature = signature;
    page.textContent = '';
    const pageInfo = inv.pages[activePage];
    if (!pageInfo) {
      return;
    }

    if (pageInfo.items.length === 0) {
      const note = doc.createElement('div');
      note.className = 'box-page-note';
      note.textContent = pageInfo.kind === 'system'
        ? '没有可用的系统元件'
        : '暂无自定义元件；保存封装后会自动出现在这里。';
      page.appendChild(note);
    }

    const grid = doc.createElement('div');
    grid.className = 'box-grid';
    for (let index = 0; index < BOX_PAGE_SIZE; index += 1) {
      const item = pageInfo.cells[index];
      const cell = doc.createElement('div');
      cell.className = 'box-cell';
      cell.dataset.page = String(pageInfo.index);
      cell.dataset.cell = String(index);
      if (!item) {
        cell.classList.add('box-cell-empty');
        cell.setAttribute('aria-hidden', 'true');
        grid.appendChild(cell);
        continue;
      }

      const pinned = inv.toolbarKeys.has(item.key);
      const pending = pendingKey();
      const boxItem = Object.assign({}, item, { pinned });
      cell.dataset.itemKey = item.key;
      cell.dataset.type = item.type;
      if (item.definitionId) {
        cell.dataset.definitionId = item.definitionId;
      }
      cell.classList.add(item.kind === 'system' ? 'box-cell-system' : 'box-cell-custom');
      if (pinned) {
        cell.classList.add('box-cell-pinned');
      }
      if (isActiveItem(item)) {
        cell.classList.add('box-cell-active');
      }
      if (pending && item.key === pending) {
        cell.classList.add('box-cell-new');
      }
      if (item.icon) {
        cell.innerHTML = item.icon;
        cell.classList.add('box-cell-icon');
      } else {
        cell.textContent = item.label;
      }
      const stateText = pinned ? '已在元件栏' : '拖到左侧元件栏';
      cell.title = item.title + (item.kind === 'system' ? '（系统元件，不可删除）' : '') +
        '；' + stateText + (item.kind === 'custom' ? '；右键管理定义' : '');
      cell.setAttribute('role', 'button');
      cell.setAttribute('aria-label', cell.title);
      cell.tabIndex = 0;
      cell.addEventListener('pointerdown', function (event) {
        startDrag(boxItem, event);
      });
      if (item.kind === 'custom' && opts.onDefinitionDoubleClick) {
        cell.addEventListener('dblclick', function (event) {
          event.preventDefault();
          opts.onDefinitionDoubleClick(item.definitionId);
        });
      }
      cell.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          if (opts.onPin) {
            opts.onPin(boxItem);
          }
        }
      });
      cell.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        if (item.kind === 'custom' && opts.onDefinitionContextMenu) {
          opts.onDefinitionContextMenu(boxItem, event);
        }
      });
      grid.appendChild(cell);
    }
    page.appendChild(grid);
  }

  function render() {
    const inv = inventory();
    if (activePage >= inv.pages.length) {
      activePage = inv.pages.length - 1;
    }
    if (activePage < 0) {
      activePage = 0;
    }
    renderTabs(inv);
    renderPage(inv);
    updateNotifyIndicator();
  }

  function setOpen(nextOpen) {
    const next = Boolean(nextOpen);
    if (next === open) {
      return;
    }
    open = next;
    if (!open) {
      cancelDrag();
      clearSeenTimer();
    }
    panel.hidden = !open;
    toggle.classList.toggle('active', open);
    toggle.setAttribute('aria-expanded', String(open));
    updateToggleIcon();
    if (open) {
      const key = pendingKey();
      let focused = false;
      if (key) {
        focused = focusPendingItem(inventory(), key);
      }
      render();
      if (key && focused && canMarkSeen()) {
        scheduleSeen(key);
      }
    } else {
      updateNotifyIndicator();
    }
  }

  toggle.addEventListener('click', function (event) {
    event.preventDefault();
    setOpen(!open);
  });
  toggle.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setOpen(!open);
    }
  });

  window.addEventListener('blur', function () {
    cancelDrag();
  });

  if (tabsPrev) {
    tabsPrev.addEventListener('click', function (event) {
      event.preventDefault();
      scrollTabs(-1);
    });
  }
  if (tabsNext) {
    tabsNext.addEventListener('click', function (event) {
      event.preventDefault();
      scrollTabs(1);
    });
  }
  tabs.addEventListener('scroll', updateTabScrollState);
  window.addEventListener('resize', updateTabScrollState);
  if (typeof ResizeObserver !== 'undefined') {
    tabsResizeObserver = new ResizeObserver(function () {
      updateTabScrollState();
    });
    tabsResizeObserver.observe(tabs);
  }

  panel.hidden = true;
  toggle.setAttribute('aria-expanded', 'false');
  updateToggleIcon();
  updateNotifyIndicator();

  return {
    refresh: function () {
      updateNotifyIndicator();
      if (!open) {
        return;
      }
      const key = pendingKey();
      if (key && (seenTimer === null || scheduledKey !== key)) {
        clearSeenTimer();
        if (focusPendingItem(inventory(), key) && canMarkSeen()) {
          scheduleSeen(key);
        }
      }
      render();
    },
    setOpen,
    setActive: function (type, definitionId) {
      activeType = type || null;
      activeDefinitionId = definitionId || null;
      applyActiveClasses();
    },
    isOpen: function () {
      return open;
    },
    containsPoint: function (clientX, clientY) {
      if (!open) {
        return false;
      }
      return ['box', 'cell', 'tab'].includes(dropTarget(clientX, clientY).kind);
    },
    getInventory: inventory
  };
}
