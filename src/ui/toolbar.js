// 职责：顶部工具栏（工具）与左侧元件栏（元件定义图标）。
// 顶部 = 工具：点击产生动作或切换模式（删除等）。
// 左侧 = meta 元件/工具：系统内建定义的图标；线也是元件（特殊：点击进入画线/接线模式）。
// 元件拖到图纸上创建真实实例；元件栏只显示已固定项，完整集合由箱子管理。
import { buildInventory } from './component-inventory.js';
const NEW_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M12 5v14M5 12h14"></path>
</svg>`.trim();

const EXPORT_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M12 3v12"></path>
  <path d="M7 8l5-5 5 5"></path>
  <path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"></path>
</svg>`.trim();

const IMPORT_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M12 15V3"></path>
  <path d="M7 10l5 5 5-5"></path>
  <path d="M4 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"></path>
</svg>`.trim();

const COPY_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <rect x="8" y="8" width="12" height="13" rx="2"></rect>
  <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2"></path>
</svg>`.trim();

const DELETE_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M4 7h16"></path>
  <path d="M10 11v6M14 11v6"></path>
  <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"></path>
  <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"></path>
</svg>`.trim();

const CONST1_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <rect x="3" y="3" width="18" height="18" rx="2"></rect>
  <text x="12" y="16.5" text-anchor="middle" font-family="system-ui, sans-serif"
        font-size="13" font-weight="700" fill="currentColor" stroke="none">1</text>
</svg>`.trim();

const TOGGLE_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <rect x="3" y="8" width="18" height="8" rx="4"></rect>
  <circle cx="16" cy="12" r="2.5"></circle>
</svg>`.trim();

const BUTTON_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <circle cx="12" cy="10" r="6"></circle>
  <circle cx="12" cy="10" r="2.5"></circle>
  <path d="M6 19h12"></path>
</svg>`.trim();

const CLOCK_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <rect x="3" y="4" width="18" height="16" rx="2"></rect>
  <path d="M5 15h3v-6h4v6h4V9h3"></path>
</svg>`.trim();

const NOT_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M5 5v14l12-7z"></path>
  <circle cx="19" cy="12" r="2"></circle>
  <path d="M2 12h3M21 12h1"></path>
</svg>`.trim();

// Internal type is DELAY; the player-facing name is “delay 门”.
const DELAY_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M2 12h3M19 12h3"></path>
  <rect x="5" y="5" width="14" height="14" rx="1"></rect>
  <text x="12" y="16" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif"
        font-size="12" fill="currentColor" stroke="none">τ</text>
</svg>`.trim();

const AND_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M4 4h7a8 8 0 0 1 0 16H4z"></path>
  <path d="M2 9h2M2 15h2M19 12h3"></path>
</svg>`.trim();

const OR_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M4 4c3 3 3 13 0 16 5 0 11-3 16-8-5-5-11-8-16-8z"></path>
  <path d="M2 9h3M2 15h3M20 12h2"></path>
</svg>`.trim();

const WIRE_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M3 17h8V7h10"></path>
  <circle cx="3" cy="17" r="1.5" fill="currentColor"></circle>
  <circle cx="21" cy="7" r="1.5" fill="currentColor"></circle>
</svg>`.trim();

const LAMP_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M9 18h6M10 21h4"></path>
  <path d="M8.5 14a5.5 5.5 0 1 1 7 0c-.8.9-1.2 2-1.2 3H9.7c0-1-.4-2.1-1.2-3z"></path>
</svg>`.trim();

const PAUSE_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <rect x="6" y="5" width="4" height="14" rx="1"></rect>
  <rect x="14" y="5" width="4" height="14" rx="1"></rect>
</svg>`.trim();

const RESET_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M4 10a8 8 0 1 1 2.3 7.5"></path>
  <path d="M4 4v6h6"></path>
</svg>`.trim();

const FRAME_ICON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <rect x="3" y="3" width="18" height="14" rx="1" stroke-dasharray="3 2"></rect>
  <rect x="13" y="12" width="8" height="5" rx="1" fill="currentColor" stroke="none"></rect>
</svg>`.trim();

export const TOOL_SLOTS = Object.freeze([
  Object.freeze({ type: 'NEW', label: '新建', title: '新建（清空当前工作现场）', icon: NEW_ICON }),
  Object.freeze({ type: 'COPY', label: '复制', title: '复制', icon: COPY_ICON }),
  Object.freeze({ type: 'DELETE', label: '删', title: '删除', icon: DELETE_ICON }),
  Object.freeze({ type: 'SIM_PAUSE', label: '暂停', title: '暂停 / 继续仿真（双击 CLOCK 设置周期）', icon: PAUSE_ICON }),
  Object.freeze({ type: 'SIM_RESET', label: '重置', title: '重置仿真时间与所有 CLOCK 输出', icon: RESET_ICON }),
  Object.freeze({ type: 'EXPORT', label: '导出', title: '导出到文件', icon: EXPORT_ICON }),
  Object.freeze({ type: 'IMPORT', label: '导入', title: '从文件导入', icon: IMPORT_ICON }),
  Object.freeze({ type: 'UNDO', label: '后退', title: '后退（最近 10 步）', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5 3 11l6 6M3 11h10a7 7 0 0 1 7 7"/></svg>' }),
  Object.freeze({ type: 'REDO', label: '前进', title: '前进', icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 6 6-6 6m6-6H11a7 7 0 0 0-7 7"/></svg>' })
]);

export const COMPONENT_SLOTS = Object.freeze([
  Object.freeze({ type: 'CONST1', label: '1', title: '常量 1', icon: CONST1_ICON }),
  Object.freeze({ type: 'TOGGLE', label: 'T', title: 'toggle', icon: TOGGLE_ICON }),
  Object.freeze({ type: 'BUTTON', label: 'B', title: 'button（按住为 1，松开为 0）', icon: BUTTON_ICON }),
  Object.freeze({ type: 'CLOCK', label: 'CLK', title: '时钟（双击设置周期）', icon: CLOCK_ICON }),
  Object.freeze({ type: 'NOT', label: 'NOT', title: 'NOT', icon: NOT_ICON }),
  Object.freeze({ type: 'AND', label: 'AND', title: 'AND', icon: AND_ICON }),
  Object.freeze({ type: 'OR', label: 'OR', title: 'OR', icon: OR_ICON }),
  Object.freeze({ type: 'WIRE', label: '线', title: '电线', icon: WIRE_ICON }),
  Object.freeze({ type: 'LAMP', label: '灯', title: '灯泡', icon: LAMP_ICON }),
  Object.freeze({ type: 'FRAME', label: '框', title: '分组框', icon: FRAME_ICON }),
  Object.freeze({ type: 'DELAY', label: 'DELAY', title: 'delay 门', icon: DELAY_ICON })
]);

export const COMPONENT_TYPES = Object.freeze(
  COMPONENT_SLOTS.filter(Boolean).map(function (slot) {
    return slot.type;
  })
);

export const TOOL_TYPES = Object.freeze(
  TOOL_SLOTS.filter(Boolean).map(function (slot) {
    return slot.type;
  })
);

// 元件图标或工具按钮的显示文字。
export function itemLabel(type) {
  const slots = COMPONENT_SLOTS.concat(TOOL_SLOTS);
  for (const slot of slots) {
    if (slot && slot.type === type) {
      return slot.label;
    }
  }
  return '';
}

// 点击栏位后的模式切换；元件进入 place，工具进入 wire/delete。
export function nextMode(current, clicked) {
  const now = current || { mode: 'select', type: null };
  if (clicked === 'FRAME') {
    if (now.mode === 'frame') {
      return { mode: 'select', type: null };
    }
    return { mode: 'frame', type: 'FRAME' };
  }
  if (clicked === 'WIRE') {
    if (now.mode === 'wire') {
      return { mode: 'select', type: null };
    }
    return { mode: 'wire', type: 'WIRE' };
  }
  if (clicked === 'DELETE') {
    if (now.mode === 'delete') {
      return { mode: 'select', type: null };
    }
    return { mode: 'delete', type: 'DELETE' };
  }
  if (now.mode === 'place' && now.type === clicked) {
    return { mode: 'select', type: null };
  }
  return { mode: 'place', type: clicked };
}

// 在浏览器中构建栏位 DOM；测试不会调用。
function buildCells(container, slots, options) {
  const handlers = options || {};
  container.textContent = '';
  const cells = [];

  for (const slot of slots) {
    const cell = document.createElement('div');
    cell.className = 'bar-item';
    if (!slot) {
      cell.classList.add('bar-empty');
      cell.setAttribute('aria-hidden', 'true');
      container.appendChild(cell);
      cells.push(cell);
      continue;
    }

    cell.dataset.type = slot.type;
    if (slot.key) {
      cell.dataset.itemKey = slot.key;
    }
    if (slot.definitionId) {
      cell.dataset.definitionId = slot.definitionId;
      cell.classList.add('bar-custom');
    }
    if (slot.icon) {
      cell.innerHTML = slot.icon;
      cell.classList.add('bar-icon');
    } else {
      cell.textContent = slot.label;
    }
    // 元件、导线、分组框都支持 Ctrl/Cmd 连续创建，悬停提示里补一句。
    const titleSuffix = handlers.titleSuffix ? handlers.titleSuffix : '';
    cell.title = slot.title + titleSuffix;
    cell.setAttribute('role', 'button');
    cell.setAttribute('aria-label', cell.title);
    cell.draggable = false;

    cell.addEventListener('pointerdown', function (event) {
      event.preventDefault();
      if (cell.getAttribute('aria-disabled') === 'true') return;
      if (slot.type === 'UNDO') {
        if (handlers.onUndo) handlers.onUndo();
      } else if (slot.type === 'REDO') {
        if (handlers.onRedo) handlers.onRedo();
      } else if (slot.type === 'WIRE') {
        if (handlers.onWireToggle) {
          handlers.onWireToggle();
        }
      } else if (slot.type === 'FRAME') {
        if (handlers.onFrameToggle) {
          handlers.onFrameToggle();
        }
      } else if (slot.type === 'DELETE') {
        if (handlers.onDeleteTool) {
          handlers.onDeleteTool();
        }
      } else if (slot.type === 'SIM_PAUSE') {
        if (handlers.onToggleSimulation) {
          handlers.onToggleSimulation();
        }
      } else if (slot.type === 'SIM_RESET') {
        if (handlers.onResetSimulation) {
          handlers.onResetSimulation();
        }
      } else if (slot.type === 'EXPORT') {
        if (handlers.onExport) {
          handlers.onExport();
        }
      } else if (slot.type === 'IMPORT') {
        if (handlers.onImport) {
          handlers.onImport();
        }
      } else if (slot.type === 'NEW') {
        if (handlers.onNewSession) {
          handlers.onNewSession();
        }
      } else if (slot.type === 'COPY') {
        if (handlers.onCopyTool) {
          handlers.onCopyTool();
        }
      } else if (handlers.onComponentDragStart) {
        handlers.onComponentDragStart(slot.type, event, slot.definitionId);
      }
    });

    if (slot.type === 'CUSTOM' && handlers.onDefinitionDoubleClick) {
      cell.addEventListener('dblclick', function (event) {
        event.preventDefault();
        handlers.onDefinitionDoubleClick(slot.definitionId);
      });
    }

    if (handlers.onItemContextMenu) {
      cell.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        handlers.onItemContextMenu(slot, event);
      });
    } else if (slot.type === 'CUSTOM') {
      cell.addEventListener('contextmenu', function (event) {
        event.preventDefault();
        if (handlers.onDefinitionContextMenu) {
          handlers.onDefinitionContextMenu(slot.definitionId, event);
        }
      });
    }

    container.appendChild(cell);
    cells.push(cell);
  }

  function setActive(type, definitionId) {
    for (const cell of cells) {
      const isActive = Boolean(type) && cell.dataset.type === type &&
        (!definitionId || cell.dataset.definitionId === definitionId);
      cell.classList.toggle('active', isActive);
    }
  }

  function setItemActive(type, active) {
    for (const cell of cells) {
      if (cell.dataset.type === type) {
        cell.classList.toggle('active', Boolean(active));
      }
    }
  }

  function setItemDisabled(type, disabled) {
    for (const cell of cells) {
      if (cell.dataset.type !== type) continue;
      cell.setAttribute('aria-disabled', String(Boolean(disabled)));
      cell.style.opacity = disabled ? '0.35' : '';
      cell.style.cursor = disabled ? 'default' : '';
    }
  }

  return { setActive, setItemActive, setItemDisabled };
}

export function createComponentBar(container, options) {
  const handlers = options || {};
  let definitions = { definitions: {} };
  let activeType = null;
  let activeDefinitionId = null;
  const hiddenTypes = new Set();
  let hiddenKeys = new Set();

  function inventory() {
    return buildInventory({
      systemSlots: COMPONENT_SLOTS,
      definitions,
      hiddenKeys,
      hiddenTypes
    });
  }

  function slots() {
    return inventory().toolbarItems.map(function (item) {
      return {
        type: item.type,
        definitionId: item.definitionId,
        key: item.key,
        label: item.label,
        title: item.title,
        icon: item.icon,
        custom: item.kind === 'custom'
      };
    });
  }

  let bar = null;
  function render() {
    bar = buildCells(container, slots(), Object.assign({}, handlers, {
      titleSuffix: '（按住 Ctrl/Cmd 可连续放置；右键可移出元件栏）'
    }));
    if (bar) bar.setActive(activeType, activeDefinitionId);
  }

  render();
  return {
    setActive(type, definitionId) {
      activeType = type || null;
      activeDefinitionId = definitionId || null;
      if (bar) bar.setActive(activeType, activeDefinitionId);
    },
    setInventoryContext(library, keys) {
      definitions = library && library.definitions ? library : { definitions: {} };
      hiddenKeys = new Set(Array.from(keys || []).filter(key => typeof key === 'string' && key));
      render();
    },
    setDefinitions(library) {
      definitions = library && library.definitions ? library : { definitions: {} };
      render();
    },
    setHiddenTypes(types) {
      hiddenTypes.clear();
      for (const type of types || []) {
        hiddenTypes.add(type);
      }
      render();
    },
    setHiddenKeys(keys) {
      hiddenKeys = new Set();
      for (const key of keys || []) {
        if (typeof key === 'string' && key) {
          hiddenKeys.add(key);
        }
      }
      render();
    },
    getHiddenTypes() {
      return Array.from(hiddenTypes);
    },
    getInventory: inventory
  };
}

export function createToolBar(container, options) {
  return buildCells(container, TOOL_SLOTS, options);
}
