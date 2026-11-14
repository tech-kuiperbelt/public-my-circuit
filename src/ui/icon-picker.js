// 通用图标下拉：触发器显示当前图标，菜单为可点击的图标网格。
import {
  COMPONENT_ICONS,
  COMPONENT_ICON_CATEGORIES,
  componentIconSvg,
  componentIconTooltip,
  getComponentIcon,
  hasComponentIcon
} from './component-icons.js';

export function createIconPicker(options) {
  const trigger = options.trigger;
  const menu = options.menu;
  const iconElement = options.iconElement;
  const labelElement = options.labelElement;
  const onSelect = options.onSelect;
  const getDisabledIcons = options.getDisabledIcons;
  let isOpen = false;
  let value = null;
  let disabledIcons = new Set();

  if (!trigger || !menu) {
    return null;
  }

  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  function labelOf(id) {
    const icon = getComponentIcon(id);
    return icon ? icon.label : '无图标';
  }

  function highlight() {
    for (const item of menu.querySelectorAll('[data-icon-id]')) {
      const selected = (item.dataset.iconId || null) === value;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
    }
  }

  function updateTrigger() {
    const valid = hasComponentIcon(value);
    if (iconElement) {
      iconElement.innerHTML = valid ? componentIconSvg(value) : '';
    }
    if (labelElement) {
      labelElement.textContent = valid ? labelOf(value) : '无图标';
    }
  }

  function setValue(next) {
    value = hasComponentIcon(next) ? next : null;
    updateTrigger();
    highlight();
  }

  function buildItem(icon) {
    const id = icon ? icon.id : null;
    const label = icon ? icon.label : '无图标';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-picker-item';
    button.dataset.iconId = id || '';
    button.setAttribute('role', 'option');
    const disabled = Boolean(id) && disabledIcons.has(id);
    if (disabled) {
      button.disabled = true;
      button.classList.add('disabled');
      button.setAttribute('aria-disabled', 'true');
    }
    const iconHtml = id ? componentIconSvg(id) : '';
    button.innerHTML = iconHtml || '<span class="icon-picker-none" aria-hidden="true">∅</span>';
    const text = document.createElement('span');
    text.className = 'icon-picker-item-label';
    text.textContent = label;
    button.appendChild(text);
    const help = icon
      ? componentIconTooltip(id)
      : '无图标：只在画布上显示元件名称';
    button.title = disabled ? help + '（已被其他元件使用）' : help;
    button.setAttribute('aria-label', label + '。' + help);
    button.addEventListener('click', function () {
      if (disabled) {
        return;
      }
      close();
      if (onSelect) {
        onSelect(id || null);
      }
    });
    return button;
  }

  function buildGroup(label) {
    const group = document.createElement('section');
    group.className = 'icon-picker-group';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    const heading = document.createElement('div');
    heading.className = 'icon-picker-group-title';
    heading.textContent = label;
    group.appendChild(heading);
    return group;
  }

  function buildGrid() {
    const grid = document.createElement('div');
    grid.className = 'icon-picker-grid';
    grid.setAttribute('role', 'presentation');
    return grid;
  }

  function render() {
    disabledIcons = typeof getDisabledIcons === 'function'
      ? new Set(getDisabledIcons() || [])
      : new Set();
    menu.textContent = '';
    const noneGrid = buildGrid();
    noneGrid.classList.add('icon-picker-none-grid');
    noneGrid.appendChild(buildItem(null));
    menu.appendChild(noneGrid);
    for (const category of COMPONENT_ICON_CATEGORIES) {
      const icons = COMPONENT_ICONS.filter(function (icon) {
        return icon.selectable !== false && icon.category === category.id;
      });
      if (icons.length === 0) {
        continue;
      }
      const group = buildGroup(category.label);
      const grid = buildGrid();
      for (const icon of icons) {
        grid.appendChild(buildItem(icon));
      }
      group.appendChild(grid);
      menu.appendChild(group);
    }
    highlight();
  }

  function position() {
    const rect = trigger.getBoundingClientRect();
    const maxWidth = Math.max(200, window.innerWidth - 16);
    const width = Math.min(Math.max(244, Math.round(rect.width)), maxWidth);
    menu.style.width = width + 'px';
    menu.style.left = '0px';
    menu.style.top = '0px';
    const height = menu.offsetHeight;
    const maxX = Math.max(4, window.innerWidth - width - 8);
    const maxY = Math.max(8, window.innerHeight - height - 8);
    const left = Math.min(Math.max(8, rect.left), maxX);
    let top = rect.bottom + 4;
    if (top + height > window.innerHeight - 8) {
      const above = rect.top - height - 4;
      top = above >= 8 ? above : maxY;
    }
    menu.style.left = left + 'px';
    menu.style.top = Math.min(top, maxY) + 'px';
  }

  function openMenu() {
    if (trigger.disabled) {
      return;
    }
    render();
    menu.hidden = false;
    position();
    isOpen = true;
    trigger.setAttribute('aria-expanded', 'true');
  }

  function close() {
    if (!isOpen) {
      return;
    }
    isOpen = false;
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  function toggle() {
    if (isOpen) {
      close();
    } else {
      openMenu();
    }
  }

  trigger.addEventListener('click', function (event) {
    event.preventDefault();
    toggle();
  });

  document.addEventListener('pointerdown', function (event) {
    if (!isOpen) {
      return;
    }
    if (menu.contains(event.target) || trigger.contains(event.target)) {
      return;
    }
    close();
  }, true);

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      close();
    }
  });

  document.addEventListener('scroll', function (event) {
    if (menu.contains(event.target)) {
      return;
    }
    close();
  }, true);
  window.addEventListener('resize', close);
  window.addEventListener('blur', close);

  setValue(null);

  return {
    open: openMenu,
    close,
    setValue,
    getValue: function () { return value; },
    isOpen: function () { return isOpen; }
  };
}
