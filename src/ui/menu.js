// 职责：上下文菜单（HTML 覆盖层）；具体菜单项由调用方按当前选择生成。
export function createMenu(element) {
  let open = false;

  function close() {
    if (!open) {
      return;
    }
    open = false;
    element.hidden = true;
    element.textContent = '';
  }

  function openAt(clientX, clientY, items) {
    element.textContent = '';
    for (const item of items || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'menu-item';
      button.textContent = item.label;
      button.addEventListener('click', function (event) {
        event.preventDefault();
        close();
        if (item.onSelect) {
          item.onSelect();
        }
      });
      element.appendChild(button);
    }
    if (element.childElementCount === 0) {
      close();
      return;
    }
    element.hidden = false;
    element.style.left = '0px';
    element.style.top = '0px';
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const maxX = Math.max(0, window.innerWidth - width - 4);
    const maxY = Math.max(0, window.innerHeight - height - 4);
    element.style.left = Math.min(clientX, maxX) + 'px';
    element.style.top = Math.min(clientY, maxY) + 'px';
    open = true;
  }

  document.addEventListener(
    'pointerdown',
    function (event) {
      if (!open) {
        return;
      }
      if (element.contains(event.target)) {
        return;
      }
      close();
    },
    true
  );

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      close();
    }
  });

  window.addEventListener('resize', close);
  window.addEventListener('blur', close);

  return { openAt, close, isOpen: function () { return open; } };
}
