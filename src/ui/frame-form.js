// 职责：分组框编辑表单（颜色 + 标签）；只做 DOM，不直接改 state。
import { FRAME_DEFAULT_COLOR, FRAME_DEFAULT_LABEL } from '../core/entities.js';

export function createFrameForm(element) {
  const form = element.querySelector('#frame-form-element');
  const colorInput = element.querySelector('#frame-form-color');
  const labelInput = element.querySelector('#frame-form-label');
  const cancelButton = element.querySelector('#frame-form-cancel');
  let current = null;

  function close() {
    current = null;
    element.hidden = true;
  }

  function open(options) {
    const source = options || {};
    current = source;
    colorInput.value = source.color || FRAME_DEFAULT_COLOR;
    labelInput.value = source.label || FRAME_DEFAULT_LABEL;
    element.hidden = false;
    labelInput.focus();
    labelInput.select();
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    const save = current && current.onSave;
    const values = {
      color: colorInput.value || FRAME_DEFAULT_COLOR,
      label: (labelInput.value || '').trim() || FRAME_DEFAULT_LABEL
    };
    close();
    if (save) {
      save(values);
    }
  });

  cancelButton.addEventListener('click', function () {
    close();
  });

  element.addEventListener('pointerdown', function (event) {
    if (event.target === element) {
      close();
    }
  });

  window.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape' || element.hidden) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    close();
  }, true);

  return {
    open,
    close,
    isOpen: function () {
      return !element.hidden;
    }
  };
}
