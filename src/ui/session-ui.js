// L3 Session 状态 UI：常驻所有权/保存提示与阻塞式读取/兼容错误。
export function createSessionUi(documentRef) {
  const doc = documentRef || document;
  const banner = doc.getElementById('session-banner');
  const bannerText = doc.getElementById('session-banner-text');
  const bannerAction = doc.getElementById('session-banner-action');
  const blocker = doc.getElementById('session-blocker');
  const blockerTitle = doc.getElementById('session-blocker-title');
  const blockerText = doc.getElementById('session-blocker-text');
  const blockerActions = doc.getElementById('session-blocker-actions');

  function showBanner(text, actionLabel, onAction) {
    bannerText.textContent = text || '';
    banner.hidden = false;
    if (actionLabel) {
      bannerAction.hidden = false;
      bannerAction.textContent = actionLabel;
      bannerAction.onclick = onAction || null;
    } else {
      bannerAction.hidden = true;
      bannerAction.textContent = '';
      bannerAction.onclick = null;
    }
  }

  function hideBanner() {
    banner.hidden = true;
    bannerAction.hidden = true;
    bannerAction.onclick = null;
  }

  function showBlocker(title, text, actions) {
    blockerTitle.textContent = title || 'Session 错误';
    blockerText.textContent = text || '';
    blockerActions.textContent = '';
    for (const action of actions || []) {
      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'session-blocker-action' + (action.primary ? ' primary' : '');
      button.textContent = action.label;
      button.addEventListener('click', function (event) {
        event.preventDefault();
        if (action.onClick) {
          action.onClick();
        }
      });
      blockerActions.appendChild(button);
    }
    blocker.hidden = false;
  }

  function hideBlocker() {
    blocker.hidden = true;
    blockerActions.textContent = '';
  }

  return { showBanner, hideBanner, showBlocker, hideBlocker };
}
