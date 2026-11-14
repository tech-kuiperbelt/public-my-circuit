// 元件箱布局的唯一可变状态；DOM、图纸和对话框由调用方协调。
import { buildInventory, applyBoxMove, applyBoxMoveToPage, removeCustomPage, customItemKey } from './component-inventory.js';

export function createComponentBoxController(options) {
  const { store, systemSlots, getDefinitions, getHiddenTypes, onChange } = options;
  let layout = store.loadLayout();
  const snapshot = () => JSON.parse(JSON.stringify(layout));
  function getInventory() {
    return buildInventory({ systemSlots, definitions: getDefinitions(),
      hiddenTypes: getHiddenTypes ? getHiddenTypes() : [], hiddenKeys: layout.hidden,
      positions: layout.positions, tabLabels: layout.tabLabels, customPages: layout.customPages });
  }
  function commit(next) {
    if (JSON.stringify(next) === JSON.stringify(layout)) return false;
    layout = next;
    store.saveLayout(snapshot());
    if (onChange) onChange();
    return true;
  }
  function setPinned(key, pinned) {
    const inv = getInventory();
    if (!inv.positions[key]) return false;
    const hidden = new Set(layout.hidden);
    if (pinned) hidden.delete(key); else hidden.add(key);
    return commit({ ...layout, hidden: Array.from(hidden) });
  }
  return {
    getLayout: snapshot,
    getInventory,
    pin: key => setPinned(key, true),
    unpin: key => setPinned(key, false),
    move(key, page, cell) {
      const positions = applyBoxMove(getInventory(), key, page, cell);
      return positions ? commit({ ...layout, positions }) : false;
    },
    moveToTab(key, page) {
      const positions = applyBoxMoveToPage(getInventory(), key, page);
      return positions ? commit({ ...layout, positions }) : false;
    },
    addTab() {
      const page = getInventory().pages.length;
      commit({ ...layout, customPages: page });
      return page;
    },
    deleteTab(page) {
      const inv = getInventory();
      const target = inv.pages[page];
      if (!Number.isInteger(page) || page < 1 || !target || target.items.length) return false;
      const removed = removeCustomPage(inv.positions, layout.tabLabels, page);
      return commit({ ...layout, ...removed, customPages: Math.max(1, inv.pages.length - 2) });
    },
    renameTab(page, label) {
      if (!Number.isInteger(page) || page < 1 || !getInventory().pages[page] || typeof label !== 'string' || !label.trim()) return false;
      if (getInventory().pages[page].label === label.trim()) return false;
      return commit({ ...layout, tabLabels: { ...layout.tabLabels, [page]: label.trim() } });
    },
    markNewDefinition(definition, isNew) {
      if (!isNew || !definition || !definition.id) return false;
      const key = customItemKey(definition.id);
      return commit({ ...layout, hidden: Array.from(new Set([...layout.hidden, key])), pendingNewItem: key });
    },
    markSeen(key) {
      if (!key || layout.pendingNewItem !== key) return false;
      return commit({ ...layout, pendingNewItem: null });
    }
  };
}
