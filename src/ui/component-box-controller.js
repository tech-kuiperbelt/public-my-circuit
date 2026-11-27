// 元件箱布局的唯一可变状态；DOM、图纸和对话框由调用方协调。
import { buildInventory, applyBoxMove, applyBoxMoveToPage, removeCustomPage, customItemKey } from './component-inventory.js';

function remainingCapacity(capacity, pinnedCount) {
  return Math.max(0, capacity - pinnedCount);
}

function pinStatus(key, capacity, inventory) {
  const position = inventory.positions[key];
  if (!inventory.hiddenSet.has(key) || !position || !inventory.pages[position.page]?.cells[position.cell]) {
    return 'unchanged';
  }
  return remainingCapacity(capacity, inventory.toolbarItems.length) > 0 ? 'available' : 'full';
}

export function createComponentBoxController(options) {
  const { store, systemSlots, getDefinitions, getHiddenTypes, onChange } = options;
  let layout = store.loadLayout();
  let unsavedLayout = false;
  const snapshot = () => JSON.parse(JSON.stringify(layout));
  function getInventory() {
    return buildInventory({ systemSlots, definitions: getDefinitions(),
      hiddenTypes: getHiddenTypes ? getHiddenTypes() : [], hiddenKeys: layout.hidden,
      positions: layout.positions, tabLabels: layout.tabLabels, customPages: layout.customPages });
  }
  function syncLayout() {
    if (unsavedLayout) return false;
    const latest = store.readLatestLayout();
    if (!latest || JSON.stringify(latest) === JSON.stringify(layout)) return false;
    layout = latest;
    return true;
  }
  function commit(next) {
    if (JSON.stringify(next) === JSON.stringify(layout)) return false;
    layout = next;
    unsavedLayout = !store.saveLayout(snapshot());
    if (onChange) onChange();
    return true;
  }
  function withLatestLayout(change) {
    return (...args) => {
      const synced = syncLayout();
      const previous = layout;
      const result = change(...args);
      if (synced && layout === previous && onChange) onChange();
      return result;
    };
  }
  return {
    getLayout: snapshot,
    getInventory,
    syncLayout,
    canPin: (key, capacity, inventory) => pinStatus(key, capacity, inventory) === 'available',
    limitImportedPins: withLatestLayout((definitionIds, capacity) => {
      const importedKeys = new Set(definitionIds.map(customItemKey));
      const { toolbarItems } = getInventory();
      const importedItems = toolbarItems.filter(item => importedKeys.has(item.key));
      const existingCount = toolbarItems.length - importedItems.length;
      const remaining = remainingCapacity(capacity, existingCount);
      const overflow = importedItems.slice(remaining).map(item => item.key);
      if (!overflow.length) return false;
      return commit({ ...layout, hidden: [...layout.hidden, ...overflow] });
    }),
    pin: withLatestLayout((key, capacity) => {
      const status = pinStatus(key, capacity, getInventory());
      if (status !== 'available') return status;
      commit({ ...layout, hidden: layout.hidden.filter(hiddenKey => hiddenKey !== key) });
      return 'pinned';
    }),
    unpin: withLatestLayout(key => {
      const inventory = getInventory();
      if (!Object.hasOwn(inventory.positions, key) || inventory.hiddenSet.has(key)) return false;
      return commit({ ...layout, hidden: [...layout.hidden, key] });
    }),
    move: withLatestLayout((key, page, cell) => {
      const positions = applyBoxMove(getInventory(), key, page, cell);
      return positions ? commit({ ...layout, positions }) : false;
    }),
    moveToTab: withLatestLayout((key, page) => {
      const inventory = getInventory();
      if (inventory.positions[key]?.page === page) return 'unchanged';
      const positions = applyBoxMoveToPage(inventory, key, page);
      if (!positions) return 'unavailable';
      commit({ ...layout, positions });
      return 'moved';
    }),
    addTab: withLatestLayout(() => {
      const page = getInventory().pages.length;
      commit({ ...layout, customPages: page });
      return page;
    }),
    deleteTab: withLatestLayout(page => {
      const inv = getInventory();
      const target = inv.pages[page];
      if (!Number.isInteger(page) || page < 1 || !target || target.items.length) return false;
      const removed = removeCustomPage(inv.positions, layout.tabLabels, page);
      return commit({ ...layout, ...removed, customPages: Math.max(1, inv.pages.length - 2) });
    }),
    renameTab: withLatestLayout((page, label) => {
      if (!Number.isInteger(page) || page < 1 || typeof label !== 'string' || !label.trim()) return false;
      const target = getInventory().pages[page];
      if (!target || target.label === label.trim()) return false;
      return commit({ ...layout, tabLabels: { ...layout.tabLabels, [page]: label.trim() } });
    }),
    markNewDefinition: withLatestLayout((definition, isNew) => {
      if (!isNew || !definition || !definition.id) return false;
      const key = customItemKey(definition.id);
      return commit({ ...layout, hidden: Array.from(new Set([...layout.hidden, key])), pendingNewItem: key });
    }),
    markSeen: withLatestLayout(key => {
      if (!key || layout.pendingNewItem !== key) return false;
      return commit({ ...layout, pendingNewItem: null });
    })
  };
}
