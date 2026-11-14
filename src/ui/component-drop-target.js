// Resolve the visible receiver, shared by hover and drop handling.
export function resolveComponentDropTarget(doc, x, y) {
  const hit = doc.elementFromPoint(x, y);
  if (!hit) return { kind: 'none' };
  const within = id => { const node = doc.getElementById(id); return node && node.contains(hit); };
  if (within('components')) return { kind: 'toolbar', element: hit };
  if (within('component-box')) {
    const cell = hit.closest('.box-cell');
    if (cell) return { kind: 'cell', element: cell };
    const tab = hit.closest('.box-tab');
    if (tab && !tab.classList.contains('box-tab-add') && Number(tab.dataset.page) >= 1)
      return { kind: 'tab', element: tab };
    return { kind: 'box', element: hit };
  }
  if (within('board')) return { kind: 'canvas', element: hit };
  return { kind: 'none' };
}
