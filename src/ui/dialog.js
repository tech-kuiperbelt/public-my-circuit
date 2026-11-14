// 项目统一对话框：确认、单行输入与多选 checkbox，不依赖浏览器原生 confirm/prompt。
export function createDialog(root) {
  const titleElement = root.querySelector('#app-dialog-title');
  const messageElement = root.querySelector('#app-dialog-message');
  const optionsElement = root.querySelector('#app-dialog-options');
  const fieldElement = root.querySelector('#app-dialog-field');
  const labelElement = root.querySelector('#app-dialog-label');
  const inputElement = root.querySelector('#app-dialog-input');
  const cancelButton = root.querySelector('#app-dialog-cancel');
  const confirmButton = root.querySelector('#app-dialog-confirm');

  let resolveCurrent = null;
  let mode = 'confirm';
  let previousFocus = null;
  let optionInputs = [];

  function selectedOptions() {
    return optionInputs.filter(function (input) {
      return input.checked && !input.disabled;
    }).map(function (input) {
      return input.value;
    });
  }

  function syncConfirmState() {
    if (mode === 'checks') {
      confirmButton.disabled = selectedOptions().length === 0;
    } else {
      confirmButton.disabled = false;
    }
  }

  function finish(value) {
    if (!resolveCurrent) {
      return;
    }
    const resolve = resolveCurrent;
    resolveCurrent = null;
    root.hidden = true;
    optionsElement.hidden = true;
    fieldElement.hidden = true;
    const focusTarget = previousFocus;
    previousFocus = null;
    if (focusTarget && typeof focusTarget.focus === 'function' && focusTarget.isConnected) {
      focusTarget.focus();
    }
    resolve(value);
  }

  function cancel() {
    if (mode === 'checks') {
      finish(null);
      return;
    }
    finish(mode === 'prompt' ? null : false);
  }

  function accept() {
    if (mode === 'prompt') {
      finish(inputElement.value);
      return;
    }
    if (mode === 'checks') {
      const selected = selectedOptions();
      if (selected.length === 0) {
        return;
      }
      finish(selected);
      return;
    }
    finish(true);
  }

  function buildOptions(options) {
    optionsElement.textContent = '';
    optionInputs = [];
    for (const item of options || []) {
      const option = document.createElement('label');
      option.className = 'app-dialog-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = item.id;
      input.checked = Boolean(item.checked);
      input.disabled = Boolean(item.disabled);
      input.addEventListener('change', syncConfirmState);
      const text = document.createElement('span');
      text.className = 'app-dialog-option-text';
      const label = document.createElement('span');
      label.className = 'app-dialog-option-label';
      label.textContent = item.label || item.id;
      text.appendChild(label);
      if (item.description) {
        const description = document.createElement('span');
        description.className = 'app-dialog-option-description';
        description.textContent = item.description;
        text.appendChild(description);
      }
      option.appendChild(input);
      option.appendChild(text);
      optionsElement.appendChild(option);
      optionInputs.push(input);
    }
  }

  function focusableElements() {
    if (mode === 'prompt') {
      return [inputElement, cancelButton, confirmButton].filter(function (element) {
        return !element.disabled && !element.hidden;
      });
    }
    if (mode === 'checks') {
      return optionInputs.filter(function (input) {
        return !input.disabled;
      }).concat([cancelButton, confirmButton]).filter(function (element) {
        return !element.disabled && !element.hidden;
      });
    }
    return [cancelButton, confirmButton].filter(function (element) {
      return !element.disabled && !element.hidden;
    });
  }

  function open(options) {
    const opts = options || {};
    if (resolveCurrent) {
      finish(mode === 'prompt' ? null : (mode === 'checks' ? null : false));
    }
    mode = opts.mode === 'prompt' ? 'prompt' : (opts.mode === 'checks' ? 'checks' : 'confirm');
    previousFocus = document.activeElement;
    titleElement.textContent = opts.title || '请确认';
    messageElement.textContent = opts.message || '';
    messageElement.hidden = !opts.message;
    fieldElement.hidden = mode !== 'prompt';
    optionsElement.hidden = mode !== 'checks';
    labelElement.textContent = opts.label || '';
    inputElement.value = opts.value || '';
    inputElement.maxLength = opts.maxLength || 60;
    cancelButton.textContent = opts.cancelLabel || '取消';
    cancelButton.hidden = Boolean(opts.hideCancel);
    confirmButton.textContent = opts.confirmLabel || '确定';
    confirmButton.classList.toggle('primary', !opts.danger);
    confirmButton.classList.toggle('danger', Boolean(opts.danger));
    if (mode === 'checks') {
      buildOptions(opts.options);
      syncConfirmState();
    } else {
      optionsElement.textContent = '';
      optionInputs = [];
      confirmButton.disabled = false;
    }
    root.hidden = false;
    if (mode === 'prompt') {
      inputElement.focus();
      inputElement.select();
    } else if (mode === 'checks') {
      const first = optionInputs.find(function (input) { return !input.disabled; });
      if (first) {
        first.focus();
      } else {
        confirmButton.focus();
      }
    } else {
      cancelButton.focus();
    }
    return new Promise(function (resolve) {
      resolveCurrent = resolve;
    });
  }

  cancelButton.addEventListener('click', cancel);
  confirmButton.addEventListener('click', accept);
  root.addEventListener('pointerdown', function (event) {
    if (event.target === root) {
      cancel();
    }
  });
  root.addEventListener('keydown', function (event) {
    event.stopPropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    if (event.key === 'Enter' && mode === 'prompt' && event.target === inputElement) {
      event.preventDefault();
      accept();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        return;
      }
      const current = focusable.indexOf(document.activeElement);
      const next = event.shiftKey
        ? focusable[(current <= 0 ? focusable.length : current) - 1]
        : focusable[(current + 1) % focusable.length];
      event.preventDefault();
      next.focus();
    }
  });

  return {
    confirm(options) {
      return open(Object.assign({}, options, { mode: 'confirm' }));
    },
    prompt(options) {
      return open(Object.assign({}, options, { mode: 'prompt' }));
    },
    checks(options) {
      return open(Object.assign({}, options, { mode: 'checks' }));
    },
    isOpen() {
      return !root.hidden;
    }
  };
}
