// 职责：右下角红色错误提示；2.5 秒自动消失，连续同因重置计时。
import { reasonText } from '../core/reasons.js';

const DISPLAY_MS = 2500;

export function createToast(element) {
  let timer = null;

  function show(reason) {
    const text = reasonText(reason) || (typeof reason === 'string' ? reason : '操作失败');
    element.textContent = text;
    element.classList.add('show');
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = setTimeout(function () {
      timer = null;
      element.classList.remove('show');
    }, DISPLAY_MS);
  }

  function hide() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    element.classList.remove('show');
  }

  return { show, hide };
}
