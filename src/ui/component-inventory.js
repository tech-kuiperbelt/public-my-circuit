// 职责：元件箱的纯数据模型。
// 系统元件固定在“系统”页；用户自定义元件从第 2 页开始按名称顺序填充。
// 左侧元件栏是箱子中元件的“固定/取消固定”视图，箱子始终保留完整元件集合。
import { componentIconSvg } from './component-icons.js';

export const BOX_COLS = 16;
export const BOX_ROWS = 10;
export const BOX_PAGE_SIZE = BOX_COLS * BOX_ROWS;
export const TOOLBAR_LAYOUT_STORAGE_KEY = 'my-circuit.toolbar-layout.v1';

export function systemItemKey(type) {
  return 'system:' + type;
}

export function customItemKey(definitionId) {
  return 'custom:' + definitionId;
}

export function itemKey(type, definitionId) {
  return type === 'CUSTOM' ? customItemKey(definitionId) : systemItemKey(type);
}

function normalizeHiddenKeys(hiddenKeys) {
  const result = [];
  const seen = new Set();
  for (const key of hiddenKeys || []) {
    if (typeof key !== 'string' || key.length === 0 || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(key);
  }
  return result;
}

function normalizePosition(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (!Number.isInteger(value.page) || value.page < 0) {
    return null;
  }
  if (!Number.isInteger(value.cell) || value.cell < 0 || value.cell >= BOX_PAGE_SIZE) {
    return null;
  }
  return { page: value.page, cell: value.cell };
}

function normalizePositions(positions) {
  const result = {};
  if (!positions || typeof positions !== 'object') {
    return result;
  }
  for (const [key, value] of Object.entries(positions)) {
    if (typeof key !== 'string' || key.length === 0) {
      continue;
    }
    const position = normalizePosition(value);
    if (position) {
      result[key] = position;
    }
  }
  return result;
}

function normalizeTabLabels(labels) {
  const result = {};
  if (!labels || typeof labels !== 'object') {
    return result;
  }
  for (const [key, value] of Object.entries(labels)) {
    const page = Number(key);
    if (!Number.isInteger(page) || page < 1) {
      continue;
    }
    if (typeof value !== 'string') {
      continue;
    }
    const label = value.trim();
    if (label.length === 0) {
      continue;
    }
    result[String(page)] = label;
  }
  return result;
}

function normalizeCustomPages(value) {
  return Number.isInteger(value) && value >= 1 ? value : 1;
}

function normalizePendingItem(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function buildSystemItems(systemSlots) {
  const items = [];
  for (const slot of systemSlots || []) {
    if (!slot || !slot.type) {
      continue;
    }
    items.push({
      key: systemItemKey(slot.type),
      kind: 'system',
      type: slot.type,
      definitionId: null,
      label: slot.label,
      title: slot.title || slot.label,
      icon: slot.icon || null,
      deletable: false
    });
  }
  return items;
}

function buildCustomItems(definitions) {
  const source = definitions && definitions.definitions &&
    typeof definitions.definitions === 'object' ? definitions.definitions : {};
  return Object.values(source)
    .filter(function (definition) {
      return Boolean(definition && definition.id);
    })
    .map(function (definition) {
      return {
        key: customItemKey(definition.id),
        kind: 'custom',
        type: 'CUSTOM',
        definitionId: definition.id,
        label: definition.name || definition.id,
        title: definition.name || definition.id,
        icon: definition.icon ? componentIconSvg(definition.icon) : null,
        deletable: true
      };
    })
    .sort(function (a, b) {
      if (a.label < b.label) return -1;
      if (a.label > b.label) return 1;
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      return 0;
    });
}

function emptyCells() {
  return new Array(BOX_PAGE_SIZE).fill(null);
}

function cellKey(page, cell) {
  return page + ':' + cell;
}

function canPlace(item, page, cell) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= BOX_PAGE_SIZE) {
    return false;
  }
  return item.kind === 'system' ? page === 0 : page >= 1;
}

export function buildInventory(options) {
  const opts = options || {};
  const hidden = normalizeHiddenKeys(opts.hiddenKeys);
  const hiddenTypes = new Set(opts.hiddenTypes || []);
  const allSystems = buildSystemItems(opts.systemSlots);
  const allCustoms = buildCustomItems(opts.definitions);
  const allItems = allSystems.concat(allCustoms);
  const requestedPositions = normalizePositions(opts.positions);
  const requestedTabLabels = normalizeTabLabels(opts.tabLabels);
  const requestedCustomPages = normalizeCustomPages(opts.customPages);
  const existingSystemKeys = new Set(allSystems.map(function (item) {
    return item.key;
  }));

  // 自定义 key 在库尚未加载时不能清理，否则 F5 后可能丢失用户的固定选择。
  const keptHidden = hidden.filter(function (key) {
    return key.indexOf('system:') !== 0 || existingSystemKeys.has(key);
  });
  const hiddenSet = new Set(keptHidden);

  const assignments = new Map();
  const occupied = new Set();

  function assign(item, page, cell) {
    assignments.set(item.key, { page, cell });
    occupied.add(cellKey(page, cell));
  }

  function isFree(page, cell) {
    return !occupied.has(cellKey(page, cell));
  }

  function firstFreeCell(page) {
    for (let cell = 0; cell < BOX_PAGE_SIZE; cell += 1) {
      if (isFree(page, cell)) {
        return cell;
      }
    }
    return -1;
  }

  // 显式位置优先；非法或冲突的位置回退到自动填充。
  for (const item of allItems) {
    const requested = requestedPositions[item.key];
    if (!requested || !canPlace(item, requested.page, requested.cell) ||
        !isFree(requested.page, requested.cell)) {
      continue;
    }
    assign(item, requested.page, requested.cell);
  }

  let maxCustomPage = 1;
  for (const item of allCustoms) {
    const position = assignments.get(item.key);
    if (position && position.page > maxCustomPage) {
      maxCustomPage = position.page;
    }
  }
  const minCustomPages = Math.max(1, Math.ceil(allCustoms.length / BOX_PAGE_SIZE));
  const customPageCount = Math.max(minCustomPages, maxCustomPage, requestedCustomPages);

  for (const item of allItems) {
    if (assignments.has(item.key)) {
      continue;
    }
    if (item.kind === 'system') {
      const cell = firstFreeCell(0);
      if (cell >= 0) {
        assign(item, 0, cell);
      }
      continue;
    }
    for (let page = 1; page <= customPageCount; page += 1) {
      const cell = firstFreeCell(page);
      if (cell >= 0) {
        assign(item, page, cell);
        break;
      }
    }
  }

  const systemCells = emptyCells();
  for (const item of allSystems) {
    const position = assignments.get(item.key);
    if (position && position.page === 0) {
      systemCells[position.cell] = item;
    }
  }
  // 封装草稿隐藏 CLOCK 时仍保留它的格子，避免关闭草稿后其他系统元件占位。
  const visibleSystemCells = systemCells.map(function (item) {
    return item && hiddenTypes.has(item.type) ? null : item;
  });
  const systems = allSystems.filter(function (item) {
    return !hiddenTypes.has(item.type);
  });

  const pages = [{
    index: 0,
    kind: 'system',
    label: '系统',
    items: visibleSystemCells.filter(Boolean),
    cells: visibleSystemCells
  }];

  for (let pageIndex = 1; pageIndex <= customPageCount; pageIndex += 1) {
    const cells = emptyCells();
    for (const item of allCustoms) {
      const position = assignments.get(item.key);
      if (position && position.page === pageIndex) {
        cells[position.cell] = item;
      }
    }
    pages.push({
      index: pageIndex,
      kind: 'custom',
      label: requestedTabLabels[String(pageIndex)] || ('自定义 ' + pageIndex),
      items: cells.filter(Boolean),
      cells
    });
  }

  const toolbarItems = systems.concat(allCustoms).filter(function (item) {
    return !hiddenSet.has(item.key);
  });

  const positions = {};
  for (const [key, position] of assignments) {
    positions[key] = { page: position.page, cell: position.cell };
  }

  return {
    systems,
    customs: allCustoms,
    toolbarItems,
    pages,
    hiddenKeys: keptHidden,
    hiddenSet,
    positions,
    tabLabels: requestedTabLabels,
    toolbarKeys: new Set(toolbarItems.map(function (item) {
      return item.key;
    }))
  };
}

// 返回移动/交换后的完整位置表；非法移动返回 null。
export function applyBoxMove(inventory, itemKeyValue, targetPage, targetCell) {
  if (!inventory || !inventory.positions) {
    return null;
  }
  if (!Number.isInteger(targetPage) || targetPage < 0 || targetPage >= inventory.pages.length) {
    return null;
  }
  if (!Number.isInteger(targetCell) || targetCell < 0 || targetCell >= BOX_PAGE_SIZE) {
    return null;
  }
  const source = inventory.positions[itemKeyValue];
  if (!source) {
    return null;
  }
  if (source.page === targetPage && source.cell === targetCell) {
    return null;
  }
  const sourcePage = inventory.pages[source.page];
  const sourceItem = sourcePage && sourcePage.cells[source.cell];
  if (!sourceItem || sourceItem.key !== itemKeyValue) {
    return null;
  }
  if (sourceItem.kind === 'system' && targetPage !== 0) {
    return null;
  }
  if (sourceItem.kind === 'custom' && targetPage < 1) {
    return null;
  }
  const targetPageInfo = inventory.pages[targetPage];
  if (!targetPageInfo) {
    return null;
  }
  const targetItem = targetPageInfo.cells[targetCell];
  if (targetItem && targetItem.kind !== sourceItem.kind) {
    return null;
  }
  if (!targetItem) {
    const reserved = Object.entries(inventory.positions).some(function (entry) {
      return entry[0] !== itemKeyValue &&
        entry[1].page === targetPage && entry[1].cell === targetCell;
    });
    if (reserved) {
      return null;
    }
  }

  const next = {};
  for (const [key, position] of Object.entries(inventory.positions)) {
    next[key] = { page: position.page, cell: position.cell };
  }
  if (targetItem) {
    next[targetItem.key] = { page: source.page, cell: source.cell };
  }
  next[itemKeyValue] = { page: targetPage, cell: targetCell };
  return next;
}

// 将自定义元件移动到另一个自定义页的第一个空格；目标页已满或类型不符返回 null。
export function applyBoxMoveToPage(inventory, itemKeyValue, targetPage) {
  if (!inventory || !inventory.positions) {
    return null;
  }
  if (!Number.isInteger(targetPage) || targetPage < 1 || targetPage >= inventory.pages.length) {
    return null;
  }
  const source = inventory.positions[itemKeyValue];
  if (!source || source.page === targetPage) {
    return null;
  }
  const sourcePage = inventory.pages[source.page];
  const sourceItem = sourcePage && sourcePage.cells[source.cell];
  if (!sourceItem || sourceItem.key !== itemKeyValue || sourceItem.kind !== 'custom') {
    return null;
  }
  const occupied = new Set();
  for (const position of Object.values(inventory.positions)) {
    if (position.page === targetPage) {
      occupied.add(position.cell);
    }
  }
  let targetCell = -1;
  for (let cell = 0; cell < BOX_PAGE_SIZE; cell += 1) {
    if (!occupied.has(cell)) {
      targetCell = cell;
      break;
    }
  }
  if (targetCell < 0) {
    return null;
  }
  return applyBoxMove(inventory, itemKeyValue, targetPage, targetCell);
}

// 删除一个自定义页后，后续页的位置与页签名称整体前移一位。
export function removeCustomPage(positions, tabLabels, pageIndex) {
  if (!Number.isInteger(pageIndex) || pageIndex < 1) {
    return {
      positions: normalizePositions(positions),
      tabLabels: normalizeTabLabels(tabLabels)
    };
  }
  const nextPositions = {};
  for (const [key, position] of Object.entries(normalizePositions(positions))) {
    nextPositions[key] = position.page > pageIndex
      ? { page: position.page - 1, cell: position.cell }
      : { page: position.page, cell: position.cell };
  }
  const nextLabels = {};
  for (const [key, label] of Object.entries(normalizeTabLabels(tabLabels))) {
    const page = Number(key);
    if (page < pageIndex) {
      nextLabels[key] = label;
    } else if (page > pageIndex) {
      nextLabels[String(page - 1)] = label;
    }
  }
  return { positions: nextPositions, tabLabels: nextLabels };
}

// 元件栏固定布局与箱子位置是浏览器本地 UI 偏好，不写入 Session/元件库。
export function createToolbarLayoutStore(storage) {
  let target = storage;
  if (target === undefined) {
    try {
      target = typeof localStorage !== 'undefined' ? localStorage : null;
    } catch (error) {
      target = null;
    }
  }

  function emptyRecord() {
    return { hidden: [], positions: {}, tabLabels: {}, customPages: 1, pendingNewItem: null };
  }

  function readRecord() {
    if (!target || typeof target.getItem !== 'function') {
      return emptyRecord();
    }
    try {
      const raw = target.getItem(TOOLBAR_LAYOUT_STORAGE_KEY);
      if (!raw) {
        return emptyRecord();
      }
      const parsed = JSON.parse(raw);
      if (!parsed || (parsed.version !== 1 && parsed.version !== 2)) {
        return emptyRecord();
      }
      return {
        hidden: Array.isArray(parsed.hidden) ? normalizeHiddenKeys(parsed.hidden) : [],
        positions: parsed.version === 2 ? normalizePositions(parsed.positions) : {},
        tabLabels: parsed.version === 2 ? normalizeTabLabels(parsed.tabLabels) : {},
        customPages: parsed.version === 2 ? normalizeCustomPages(parsed.customPages) : 1,
        pendingNewItem: parsed.version === 2 ? normalizePendingItem(parsed.pendingNewItem) : null
      };
    } catch (error) {
      return emptyRecord();
    }
  }

  function writeRecord(record) {
    if (!target || typeof target.setItem !== 'function') {
      return false;
    }
    try {
      target.setItem(TOOLBAR_LAYOUT_STORAGE_KEY, JSON.stringify({
        version: 2,
        hidden: normalizeHiddenKeys(record.hidden),
        positions: normalizePositions(record.positions),
        tabLabels: normalizeTabLabels(record.tabLabels),
        customPages: normalizeCustomPages(record.customPages),
        pendingNewItem: normalizePendingItem(record.pendingNewItem)
      }));
      return true;
    } catch (error) {
      return false;
    }
  }

  function load() {
    return readRecord().hidden;
  }

  function loadPositions() {
    return readRecord().positions;
  }

  function loadTabLabels() {
    return readRecord().tabLabels;
  }

  function loadCustomPages() {
    return readRecord().customPages;
  }

  function loadPendingNewItem() {
    return readRecord().pendingNewItem;
  }

  function save(hiddenKeys) {
    const record = readRecord();
    record.hidden = hiddenKeys;
    return writeRecord(record);
  }

  function savePositions(positions) {
    const record = readRecord();
    record.positions = positions;
    return writeRecord(record);
  }

  function saveTabLabels(labels) {
    const record = readRecord();
    record.tabLabels = labels;
    return writeRecord(record);
  }

  function saveCustomPages(count) {
    const record = readRecord();
    record.customPages = count;
    return writeRecord(record);
  }

  function savePendingNewItem(key) {
    const record = readRecord();
    record.pendingNewItem = key;
    return writeRecord(record);
  }

  return {
    loadLayout: readRecord,
    saveLayout: writeRecord,
    load,
    loadPositions,
    loadTabLabels,
    loadCustomPages,
    loadPendingNewItem,
    save,
    savePositions,
    saveTabLabels,
    saveCustomPages,
    savePendingNewItem
  };
}
