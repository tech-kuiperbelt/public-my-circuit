// L3 Session 编排：启动恢复、自动保存、New、编辑所有权和旧写入防护。
// 真正的写入一致性由 session-store 的 IndexedDB 事务（owner + revision）保证；
// Web Locks 用于当前页面的存活状态，BroadcastChannel 仅用于尽快通知 UI。
import { createSnapshot, prepareSnapshotRestore, validateSnapshot } from '../core/snapshot.js';
import { planImport } from '../core/bundle.js';
import { MAX_SCALE, MIN_SCALE } from './view.js';
import {
  LIBRARY_SCHEMA_VERSION,
  OWNER_LEASE_MS,
  SESSION_SCHEMA_VERSION
} from './session-store.js';
import {
  applyLibraryMutation,
  precheckLibraryMutation,
  emptyLibrary,
  validateLibraryRecord
} from './library.js';

const LOCK_NAME = 'my-circuit-session-editor';
const CHANNEL_NAME = 'my-circuit-session';

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorInfo(error) {
  if (!error) {
    return { name: 'Error', message: 'unknown error' };
  }
  return {
    name: error.name || 'Error',
    message: error.message || String(error)
  };
}

function reasonText(result) {
  if (!result) {
    return '未知错误';
  }
  if (result.error) {
    return result.error.name + ': ' + result.error.message;
  }
  return result.reason || '未知错误';
}

function normalizeView(view) {
  if (!isObject(view) || !Number.isFinite(view.scale) ||
      !isObject(view.pan) || !Number.isFinite(view.pan.x) || !Number.isFinite(view.pan.y)) {
    return null;
  }
  return {
    scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale)),
    pan: { x: view.pan.x, y: view.pan.y }
  };
}

function copyView(view) {
  return { scale: view.scale, pan: { x: view.pan.x, y: view.pan.y } };
}

function randomId(prefix) {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return prefix + '-' + crypto.randomUUID();
  }
  return prefix + '-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
}

function acquireLock(locks, name, steal) {
  if (!locks || typeof locks.request !== 'function') {
    return Promise.resolve({ ok: true, fallback: true, release: function () {} });
  }
  return new Promise(function (resolve) {
    let settled = false;
    let releaseHeld = null;
    function finish(value) {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    }
    let request;
    try {
      const options = steal
        ? { mode: 'exclusive', steal: true }
        : { mode: 'exclusive', ifAvailable: true };
      request = locks.request(name, options, function (lock) {
        if (!lock) {
          finish({ ok: false, reason: 'LOCKED' });
          return undefined;
        }
        let release;
        const held = new Promise(function (resolveHeld) {
          release = resolveHeld;
        });
        releaseHeld = function () {
          if (release) {
            release();
          }
        };
        finish({
          ok: true,
          release: function () {
            if (releaseHeld) {
              releaseHeld();
              releaseHeld = null;
            }
          }
        });
        return held;
      });
      if (request && typeof request.catch === 'function') {
        request.catch(function (error) {
          finish({ ok: false, reason: 'LOCK_ERROR', error: errorInfo(error) });
        });
      }
    } catch (error) {
      finish({ ok: false, reason: 'LOCK_ERROR', error: errorInfo(error) });
    }
  });
}

export function createSessionController(options = {}) {
  const store = options.store;
  const ui = options.ui;
  const getWorkspace = options.getWorkspace;
  const applyWorkspace = options.applyWorkspace;
  const createBlankWorkspace = options.createBlankWorkspace;
  const applyLibrary = typeof options.applyLibrary === 'function'
    ? options.applyLibrary
    : function () {};
  const libraryLimits = options.libraryLimits;
  const confirmAction = typeof options.confirm === 'function'
    ? options.confirm
    : function () {
      return Promise.resolve(false);
    };
  const reload = typeof options.reload === 'function'
    ? options.reload
    : function () {
      if (typeof window !== 'undefined' && window.location) {
        window.location.reload();
      }
    };
  const tabId = options.tabId || randomId('tab');
  const instanceId = options.instanceId || randomId('instance');
  const now = options.now || Date.now;
  const leaseMs = options.leaseMs || OWNER_LEASE_MS;
  const heartbeatMs = options.heartbeatMs || Math.max(500, Math.floor(leaseMs / 2));
  const pollMs = options.pollMs || 750;
  const viewDebounceMs = options.viewDebounceMs === undefined ? 200 : options.viewDebounceMs;
  const locks = options.locks === undefined
    ? (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null)
    : options.locks;
  const lockName = options.lockName || LOCK_NAME;
  const channelName = options.channelName || CHANNEL_NAME;
  const createChannel = options.createChannel === undefined
    ? (typeof BroadcastChannel !== 'undefined'
      ? function () { return new BroadcastChannel(channelName); }
      : null)
    : options.createChannel;
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const setTimeoutFn = options.setTimeout || setTimeout;
  const clearTimeoutFn = options.clearTimeout || clearTimeout;

  let owner = false;
  let ownerRecord = null;
  let library = emptyLibrary();
  let libraryRevision = 0;
  let libraryReady = false;
  let ready = false;
  let blocked = false;
  let busy = false;
  let disposed = false;
  let started = false;
  let lastRevision = 0;
  let pending = null;
  let generation = 0;
  let writing = null;
  let saveError = null;
  let notice = '';
  let viewDirty = false;
  let viewTimer = null;
  let heartbeatTimer = null;
  let pollTimer = null;
  let channel = null;
  let lockRelease = null;
  let releasePending = null;

  function canEdit() {
    return ready && owner && !blocked && !busy && !disposed;
  }

  function getStatus() {
    return {
      tabId,
      instanceId,
      owner,
      canEdit: canEdit(),
      blocked,
      busy,
      ready,
      revision: lastRevision,
      libraryRevision,
      libraryReady,
      definitionCount: Object.keys(library.definitions).length,
      saveError,
      notice,
      ownerTabId: ownerRecord ? ownerRecord.tabId : null
    };
  }

  function applyLibraryState(definitions, revision, change) {
    library = { definitions: definitions && typeof definitions === 'object' ? definitions : {} };
    libraryRevision = Number.isInteger(revision) && revision >= 0 ? revision : 0;
    libraryReady = true;
    applyLibrary(library, change);
  }

  function prepareLibrary(record) {
    if (record === undefined || record === null) {
      applyLibraryState({}, 0);
      return { ok: true, empty: true };
    }
    if (!isObject(record) || !Number.isInteger(record.schemaVersion)) {
      return { ok: false, reason: 'LIBRARY_CORRUPT' };
    }
    if (record.schemaVersion !== LIBRARY_SCHEMA_VERSION) {
      return { ok: false, reason: 'LIBRARY_INCOMPATIBLE' };
    }
    if (!Number.isInteger(record.revision) || record.revision < 0) {
      return { ok: false, reason: 'LIBRARY_CORRUPT' };
    }
    let checked;
    try {
      checked = validateLibraryRecord(record, libraryLimits);
    } catch (error) {
      return { ok: false, reason: 'LIBRARY_INVALID', detail: errorInfo(error).message };
    }
    if (!checked.ok) {
      return {
        ok: false,
        reason: 'LIBRARY_INVALID',
        detail: checked.reason + (checked.detail ? ':' + checked.detail : '')
      };
    }
    applyLibraryState(record.definitions, record.revision);
    return { ok: true };
  }

  function cloneValue(value) {
    if (typeof structuredClone === 'function') {
      return structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  function cancelViewTimer() {
    if (viewTimer !== null) {
      clearTimeoutFn(viewTimer);
      viewTimer = null;
    }
  }

  function cancelPending() {
    generation += 1;
    pending = null;
    cancelViewTimer();
  }

  function stopTimers() {
    if (heartbeatTimer !== null) {
      clearIntervalFn(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (pollTimer !== null) {
      clearIntervalFn(pollTimer);
      pollTimer = null;
    }
  }

  function startTimers() {
    stopTimers();
    if (disposed || blocked) {
      return;
    }
    if (owner) {
      heartbeatTimer = setIntervalFn(function () {
        void heartbeat();
      }, heartbeatMs);
    }
    pollTimer = setIntervalFn(function () {
      void checkOwner();
    }, pollMs);
  }

  function releaseLock() {
    if (lockRelease) {
      const release = lockRelease;
      lockRelease = null;
      try {
        release();
      } catch (error) {
        // Ignore release errors.
      }
    }
  }

  function setupChannel() {
    if (channel || !createChannel) {
      return;
    }
    try {
      channel = createChannel();
      channel.onmessage = function (event) {
        const data = event && event.data;
        if (data && (data.type === 'owner-changed' || data.type === 'session-updated')) {
          void checkOwner();
        }
      };
    } catch (error) {
      channel = null;
    }
  }

  function broadcast(type) {
    if (!channel) {
      return;
    }
    try {
      channel.postMessage({
        type,
        tabId,
        instanceId,
        at: now()
      });
    } catch (error) {
      // Notifications are best effort; IndexedDB remains the authority.
    }
  }

  function updateBanner() {
    if (!ui) {
      return;
    }
    if (blocked) {
      ui.hideBanner();
      return;
    }
    if (!ready) {
      ui.hideBanner();
      return;
    }
    if (busy) {
      ui.showBanner('正在准备 Session…', null, null);
      return;
    }
    if (!owner) {
      const text = notice || (ownerRecord
        ? '另一个页面正在编辑，本页面暂时不可编辑。'
        : '当前没有编辑者。');
      ui.showBanner(text, '接管编辑', takeover);
      return;
    }
    if (saveError) {
      ui.showBanner('修改尚未持久化：' + saveError, '重试保存', retrySave);
      return;
    }
    ui.hideBanner();
  }

  function enterBlocked(title, message, discardMode) {
    const clearAll = discardMode === 'all';
    blocked = true;
    ready = true;
    busy = false;
    owner = false;
    ownerRecord = null;
    notice = '';
    saveError = null;
    cancelPending();
    stopTimers();
    releaseLock();
    ui.showBlocker(title, message, [
      {
        label: '重试',
        primary: true,
        onClick: reload
      },
      {
        label: clearAll ? '放弃并清空全部数据' : '放弃并清空',
        onClick: function () { return abandonWorkspace(clearAll); }
      }
    ]);
    ui.hideBanner();
    broadcast('owner-changed');
    if (store) {
      try {
        releasePending = Promise.resolve(store.releaseOwnership({ tabId, instanceId }))
          .catch(function () {
            return { ok: false };
          });
      } catch (error) {
        releasePending = Promise.resolve({ ok: false });
      }
    }
  }

  // 阻塞错误下显式放弃本地数据：重新取得编辑权后删除记录并回到空白工作区。
  // 普通读取失败/abort/所有权冲突不会走到这里；只有用户点击确认才清空。
  async function abandonWorkspace(includeLibrary) {
    if (disposed || !store) {
      return { ok: false, reason: 'UNAVAILABLE' };
    }
    if (busy) {
      return { ok: false, reason: 'BUSY' };
    }
    const message = includeLibrary
      ? '放弃并清空本地元件库与 Session？此操作无法撤销。'
      : '放弃并清空本地 Session？此操作无法撤销。';
    const confirmed = await confirmAction(message, {
      title: '放弃本地数据？',
      confirmLabel: '放弃并清空',
      danger: true
    });
    if (!confirmed) {
      return { ok: false, reason: 'CANCELLED' };
    }
    busy = true;

    // enterBlocked 的所有权释放可能是异步的；先等它结束，避免它删掉刚重新取得的所有权。
    const pendingRelease = releasePending;
    releasePending = null;
    if (pendingRelease) {
      try {
        await pendingRelease;
      } catch (error) {
        // Release is best effort; a failed release does not block a takeover.
      }
    }

    const lock = await acquireLock(locks, lockName, true);
    if (!lock.ok && lock.reason !== 'LOCK_ERROR') {
      busy = false;
      enterBlocked('无法取得编辑权', '清空失败：编辑锁仍被占用。请关闭其它编辑页面后重试。', includeLibrary ? 'all' : 'session');
      return { ok: false, reason: lock.reason || 'LOCK_FAILED' };
    }
    if (lock.ok && !lock.fallback) {
      lockRelease = lock.release;
    }

    const claimed = await store.claimOwnership({ tabId, instanceId, takeover: true });
    if (!claimed.ok) {
      releaseLock();
      busy = false;
      enterBlocked('无法取得编辑权', '清空失败：' + reasonText(claimed), includeLibrary ? 'all' : 'session');
      return { ok: false, reason: claimed.reason || 'CLAIM_FAILED' };
    }
    owner = true;
    ownerRecord = claimed.owner;

    const cleared = includeLibrary
      ? await store.clearWorkspace({ tabId, instanceId, library: true, session: true })
      : await store.clearSession({ tabId, instanceId });
    if (!cleared.ok) {
      busy = false;
      enterBlocked('清空本地数据失败', '原数据已保留：' + reasonText(cleared), includeLibrary ? 'all' : 'session');
      return { ok: false, reason: cleared.reason || 'CLEAR_FAILED' };
    }
    if (includeLibrary) {
      applyLibraryState({}, 0);
    }

    try {
      applyBlank();
    } catch (error) {
      busy = false;
      enterBlocked('应用空白工作区失败', errorInfo(error).message, includeLibrary ? 'all' : 'session');
      return { ok: false, blocked: true, reason: 'BLANK_FAILED' };
    }

    blocked = false;
    ready = true;
    busy = false;
    notice = '';
    saveError = null;
    if (!channel) {
      setupChannel();
    }
    startTimers();
    ui.hideBlocker();
    updateBanner();
    broadcast('owner-changed');
    broadcast('session-updated');
    return { ok: true, cleared: true, blank: true };
  }

  function applyBlank() {
    const blank = createBlankWorkspace();
    viewDirty = false;
    const view = normalizeView(blank.view);
    if (!view) {
      throw new Error('blank workspace has invalid view');
    }
    const snapshot = createSnapshot(blank.state, blank.evaluation);
    const checked = validateSnapshot(snapshot, { definitions: library });
    if (!checked.ok) {
      throw new Error('blank workspace snapshot is invalid: ' + checked.reason);
    }
    applyWorkspace({
      state: snapshot.state,
      evaluation: snapshot.evaluation,
      view
    });
    lastRevision = 0;
    notice = '';
    saveError = null;
  }

  async function applyRecord(record) {
    if (record === undefined || record === null) {
      applyBlank();
      return { ok: true, blank: true };
    }
    if (!isObject(record) || !Object.prototype.hasOwnProperty.call(record, 'schemaVersion')) {
      enterBlocked('本地 Session 数据损坏', '记录缺少版本信息，原数据已保留。');
      return { ok: false, blocked: true, reason: 'CORRUPT' };
    }
    if (!Number.isInteger(record.schemaVersion)) {
      enterBlocked('本地 Session 数据损坏', '记录版本字段无效，原数据已保留。');
      return { ok: false, blocked: true, reason: 'CORRUPT' };
    }
    if (record.schemaVersion !== SESSION_SCHEMA_VERSION) {
      if (!owner) {
        notice = '本地 Session 版本不兼容；接管编辑后可处理。';
        return { ok: false, blocked: false, reason: 'INCOMPATIBLE_READONLY' };
      }
      const confirmed = await confirmAction('本地 Session 版本不兼容。清空本地 Session 并重新开始？', {
        title: 'Session 版本不兼容',
        confirmLabel: '清空并开始'
      });
      if (!confirmed) {
        enterBlocked('本地 Session 版本不兼容', '未清空本地数据。请重试，或使用“放弃并清空”重新开始。');
        return { ok: false, blocked: true, reason: 'INCOMPATIBLE_CANCELLED' };
      }
      const cleared = await store.clearSession({ tabId, instanceId });
      if (!cleared.ok) {
        enterBlocked('清空本地 Session 失败', '原数据已保留：' + reasonText(cleared));
        return { ok: false, blocked: true, reason: 'CLEAR_FAILED' };
      }
      applyBlank();
      broadcast('session-updated');
      return { ok: true, cleared: true, blank: true };
    }
    if (!Number.isInteger(record.revision) || record.revision < 0) {
      enterBlocked('本地 Session 数据损坏', '记录写入版本无效，原数据已保留。');
      return { ok: false, blocked: true, reason: 'CORRUPT' };
    }
    const prepared = prepareSnapshotRestore(record, { definitions: library });
    if (!prepared.ok) {
      enterBlocked('本地 Session 数据损坏', '快照校验失败，原数据已保留：' +
        prepared.reason + (prepared.detail ? ' / ' + prepared.detail : ''));
      return { ok: false, blocked: true, reason: 'CORRUPT' };
    }
    const view = normalizeView(record.view);
    if (!view) {
      enterBlocked('本地 Session 数据损坏', '画布视图无效，原数据已保留。');
      return { ok: false, blocked: true, reason: 'CORRUPT' };
    }
    applyWorkspace({
      state: prepared.state,
      evaluation: prepared.evaluation,
      view
    });
    viewDirty = false;
    lastRevision = record.revision;
    notice = '';
    saveError = null;
    return { ok: true, restored: true };
  }

  async function initialize() {
    if (started) {
      return { ok: !blocked, status: getStatus() };
    }
    started = true;
    const opened = await store.open();
    if (!opened.ok) {
      enterBlocked('无法读取本地 Session', 'IndexedDB 不可用或打开失败：' + reasonText(opened));
      return { ok: false, blocked: true };
    }

    const ownerRead = await store.readOwner();
    const previousOwner = ownerRead.ok ? ownerRead.value : null;
    const sameTab = previousOwner && previousOwner.tabId === tabId;
    const lock = await acquireLock(locks, lockName, Boolean(sameTab));
    if (lock.ok && !lock.fallback) {
      lockRelease = lock.release;
    }

    const lockUsable = lock.ok || lock.reason === 'LOCK_ERROR';
    if (lockUsable) {
      const claimed = await store.claimOwnership({
        tabId,
        instanceId,
        takeover: Boolean((lock.ok && !lock.fallback) || (lock.reason === 'LOCK_ERROR' && sameTab))
      });
      if (!claimed.ok) {
        releaseLock();
        if (claimed.reason === 'OWNED') {
          owner = false;
          ownerRecord = claimed.owner || null;
        } else {
          enterBlocked('无法取得编辑权', 'IndexedDB 写入失败：' + reasonText(claimed));
          return { ok: false, blocked: true };
        }
      } else {
        owner = true;
        ownerRecord = claimed.owner;
      }
    } else {
      owner = false;
      ownerRecord = previousOwner || null;
    }

    const loaded = await store.readWorkspaceBundle();
    if (!loaded.ok) {
      enterBlocked('无法读取本地数据', '读取失败，原数据已保留：' + reasonText(loaded));
      return { ok: false, blocked: true };
    }

    const preparedLibrary = prepareLibrary(loaded.library);
    if (!preparedLibrary.ok) {
      if (!owner) {
        notice = '本地元件库不可用；接管编辑后可处理。';
        ready = true;
        setupChannel();
        startTimers();
        updateBanner();
        return { ok: false, blocked: false, reason: preparedLibrary.reason };
      }
      const message = preparedLibrary.reason === 'LIBRARY_INCOMPATIBLE'
        ? '本地元件库版本不兼容，原数据已保留。'
        : '本地元件库损坏或校验失败，原数据已保留：' +
          (preparedLibrary.detail || preparedLibrary.reason);
      enterBlocked('本地元件库不可用', message, 'all');
      return { ok: false, blocked: true, reason: preparedLibrary.reason };
    }

    const applied = await applyRecord(loaded.session);
    if (blocked) {
      return { ok: false, blocked: true, reason: 'BLOCKED' };
    }
    ready = true;
    setupChannel();
    startTimers();
    updateBanner();
    if (owner) {
      broadcast('owner-changed');
    }
    return {
      ok: applied.ok,
      restored: Boolean(applied.restored),
      blank: Boolean(applied.blank),
      owner,
      status: getStatus()
    };
  }

  function loseOwnership(message) {
    owner = false;
    ownerRecord = null;
    busy = false;
    saveError = null;
    notice = message || '编辑权已被其他页面接管。';
    cancelPending();
    stopTimers();
    releaseLock();
    startTimers();
    updateBanner();
  }

  async function checkOwner() {
    if (disposed || blocked) {
      return;
    }
    const result = await store.readOwner();
    if (!result.ok) {
      return;
    }
    const current = result.value;
    const active = current && Number.isInteger(current.expiresAt) && current.expiresAt > now();
    if (owner) {
      if (!current || current.tabId !== tabId || current.instanceId !== instanceId) {
        loseOwnership('编辑权已被其他页面接管。');
      } else {
        ownerRecord = current;
      }
      return;
    }
    ownerRecord = active ? current : null;
    updateBanner();
  }

  async function heartbeat() {
    if (disposed || blocked || !owner) {
      return;
    }
    const result = await store.renewOwnership({ tabId, instanceId });
    if (!result.ok) {
      if (result.reason === 'NOT_OWNER') {
        loseOwnership('编辑权已被其他页面接管。');
      }
    }
  }

  async function takeover() {
    if (disposed || blocked) {
      return { ok: false, reason: 'BLOCKED' };
    }
    if (owner || busy) {
      return { ok: owner, reason: owner ? 'ALREADY_OWNER' : 'BUSY' };
    }
    busy = true;
    notice = '';
    updateBanner();
    cancelPending();
    if (writing) {
      try {
        await writing;
      } catch (error) {
        // The write queue handles its own errors.
      }
    }
    const lock = await acquireLock(locks, lockName, true);
    if (!lock.ok && lock.reason !== 'LOCK_ERROR') {
      busy = false;
      notice = '接管失败：编辑锁仍被占用。';
      updateBanner();
      return { ok: false, reason: lock.reason || 'LOCK_FAILED' };
    }
    if (lock.ok && !lock.fallback) {
      lockRelease = lock.release;
    }
    const claimed = await store.claimOwnership({ tabId, instanceId, takeover: true });
    if (!claimed.ok) {
      releaseLock();
      busy = false;
      notice = '接管失败。';
      updateBanner();
      return { ok: false, reason: claimed.reason || 'CLAIM_FAILED' };
    }
    owner = true;
    ownerRecord = claimed.owner;
    broadcast('owner-changed');
    const loaded = await store.readWorkspaceBundle();
    if (!loaded.ok) {
      enterBlocked('无法读取最新数据', '读取失败，原数据已保留：' + reasonText(loaded));
      return { ok: false, blocked: true };
    }
    const preparedLibrary = prepareLibrary(loaded.library);
    if (!preparedLibrary.ok) {
      enterBlocked('本地元件库不可用', '接管后校验失败，原数据已保留：' +
        (preparedLibrary.detail || preparedLibrary.reason), 'all');
      return { ok: false, blocked: true, reason: preparedLibrary.reason };
    }
    const applied = await applyRecord(loaded.session);
    if (blocked) {
      return { ok: false, blocked: true };
    }
    busy = false;
    ready = true;
    startTimers();
    updateBanner();
    return { ok: true, restored: Boolean(applied.restored), blank: Boolean(applied.blank) };
  }

  function scheduleSave() {
    if (!canEdit()) {
      return;
    }
    const workspace = getWorkspace();
    const snapshot = createSnapshot(workspace.state, workspace.evaluation);
    const checked = validateSnapshot(snapshot, { definitions: library });
    if (!checked.ok) {
      saveError = '快照校验失败：' + checked.reason;
      updateBanner();
      return;
    }
    const view = normalizeView(workspace.view);
    if (!view) {
      saveError = '画布视图无效';
      updateBanner();
      return;
    }
    pending = {
      generation,
      state: snapshot.state,
      evaluation: snapshot.evaluation,
      view: copyView(view)
    };
    viewDirty = false;
    void drain();
  }

  function drain() {
    if (writing) {
      return writing;
    }
    writing = (async function () {
      while (pending && pending.generation === generation && !disposed) {
        const item = pending;
        pending = null;
        const result = await store.saveSession({
          tabId,
          instanceId,
          expectedRevision: lastRevision,
          state: item.state,
          evaluation: item.evaluation,
          view: item.view
        });
        if (result.ok) {
          lastRevision = result.revision;
          if (item.generation === generation) {
            saveError = null;
            if (owner) {
              updateBanner();
            }
          }
          broadcast('session-updated');
          continue;
        }
        if (result.reason === 'NOT_OWNER') {
          loseOwnership('编辑权已被其他页面接管，修改未保存。');
          break;
        }
        if (item.generation === generation) {
          saveError = reasonText(result);
          pending = item;
          updateBanner();
        }
        break;
      }
    })().finally(function () {
      writing = null;
      if (pending && pending.generation === generation && !saveError && !disposed) {
        void drain();
      }
    });
    return writing;
  }

  async function flush() {
    cancelViewTimer();
    if (canEdit() && viewDirty) {
      scheduleSave();
    }
    if (writing) {
      try {
        await writing;
      } catch (error) {
        // Errors are represented by saveError.
      }
    }
    if (!writing && pending && !saveError && canEdit()) {
      await drain();
    }
    return {
      ok: Boolean(owner) && !saveError,
      revision: lastRevision,
      saveError,
      reason: owner ? undefined : 'NOT_OWNER'
    };
  }

  async function retrySave() {
    if (!canEdit()) {
      updateBanner();
      return { ok: false, reason: 'READ_ONLY' };
    }
    if (!pending) {
      scheduleSave();
    }
    if (!pending && !writing) {
      return { ok: !saveError, revision: lastRevision, saveError };
    }
    await drain();
    return { ok: !saveError, revision: lastRevision, saveError };
  }

  async function requestNew() {
    if (!canEdit()) {
      updateBanner();
      return { ok: false, reason: 'READ_ONLY' };
    }
    if (busy) {
      return { ok: false, reason: 'BUSY' };
    }
    const confirmed = await confirmAction('新建会清空当前工作现场，且无法撤销。继续？', {
      title: '新建工作现场？',
      confirmLabel: '新建'
    });
    if (!confirmed) {
      return { ok: false, reason: 'CANCELLED' };
    }
    busy = true;
    notice = '';
    updateBanner();
    cancelPending();
    if (writing) {
      try {
        await writing;
      } catch (error) {
        // The write queue handles its own errors.
      }
    }
    if (!owner || blocked || disposed) {
      busy = false;
      updateBanner();
      return { ok: false, reason: 'READ_ONLY' };
    }
    let workspace;
    try {
      workspace = createBlankWorkspace();
    } catch (error) {
      busy = false;
      saveError = errorInfo(error).message;
      updateBanner();
      return { ok: false, reason: 'BLANK_FAILED' };
    }
    const snapshot = createSnapshot(workspace.state, workspace.evaluation);
    const checked = validateSnapshot(snapshot, { definitions: library });
    const view = normalizeView(workspace.view);
    if (!checked.ok || !view) {
      busy = false;
      saveError = checked.ok ? '空白工作区视图无效' : '空白工作区快照无效';
      updateBanner();
      return { ok: false, reason: 'INVALID_BLANK' };
    }
    const saved = await store.saveSession({
      tabId,
      instanceId,
      expectedRevision: lastRevision,
      state: snapshot.state,
      evaluation: snapshot.evaluation,
      view: copyView(view)
    });
    if (!saved.ok) {
      busy = false;
      if (saved.reason === 'NOT_OWNER') {
        loseOwnership('编辑权已被其他页面接管，新建未保存。');
      } else {
        saveError = reasonText(saved);
        updateBanner();
      }
      return { ok: false, reason: saved.reason || 'SAVE_FAILED' };
    }
    lastRevision = saved.revision;
    try {
      applyWorkspace({
        state: snapshot.state,
        evaluation: snapshot.evaluation,
        view
      });
      viewDirty = false;
    } catch (error) {
      enterBlocked('应用新工作区失败', errorInfo(error).message);
      return { ok: false, blocked: true };
    }
    saveError = null;
    busy = false;
    updateBanner();
    broadcast('session-updated');
    return { ok: true, revision: saved.revision };
  }

  async function mutateLibraryOperation(kind, payload) {
    if (disposed || blocked) {
      return { ok: false, reason: 'BLOCKED' };
    }
    if (!canEdit()) {
      return { ok: false, reason: 'READ_ONLY' };
    }
    const flushed = await flush();
    if (!flushed.ok) {
      return {
        ok: false,
        reason: flushed.reason || 'SESSION_FLUSH_FAILED',
        detail: flushed.saveError
      };
    }
    if (disposed || blocked || !canEdit()) {
      return { ok: false, reason: 'READ_ONLY' };
    }

    let candidate = null;
    let precheck;
    try {
      if (kind === 'create' || kind === 'update') candidate = cloneValue(payload);
      precheck = precheckLibraryMutation(kind, kind === 'delete' ? payload : candidate,
        library, function () { return getWorkspace().state; }, libraryLimits);
    } catch (error) {
      return { ok: false, reason: 'INVALID_DEFINITION', detail: errorInfo(error).message };
    }
    if (!precheck.ok) return precheck;

    busy = true;
    updateBanner();
    try {
      const result = await store.mutateLibrary({
        tabId,
        instanceId,
        expectedRevision: libraryRevision,
        mutate: function (record) {
          return applyLibraryMutation(kind, kind === 'delete' ? payload : candidate,
            record.library, record.session && record.session.state);
        }
      });
      if (!result.ok) {
        if (result.reason === 'NOT_OWNER') {
          loseOwnership('编辑权已被其他页面接管，元件库修改未保存。');
        }
        return {
          ok: false,
          reason: result.reason,
          detail: result.detail,
          references: result.references,
          error: result.error
        };
      }
      applyLibraryState(result.library.definitions, result.revision);
      return {
        ok: true,
        revision: result.revision,
        definition: kind === 'delete' ? null : candidate,
        library
      };
    } finally {
      busy = false;
      updateBanner();
    }
  }

  function createDefinition(candidate) {
    return mutateLibraryOperation('create', candidate);
  }

  function updateDefinition(candidate) {
    return mutateLibraryOperation('update', candidate);
  }

  function deleteDefinition(id) {
    return mutateLibraryOperation('delete', id);
  }

  function previewImport(bundle, selection) {
    if (disposed || blocked) {
      return { ok: false, reason: 'BLOCKED' };
    }
    if (!ready) {
      return { ok: false, reason: 'NOT_READY' };
    }
    const workspace = getWorkspace();
    return planImport({
      bundle,
      selection,
      library,
      state: workspace.state,
      evaluation: workspace.evaluation,
      view: workspace.view,
      limits: libraryLimits
    });
  }

  async function importBundle(bundle, selection) {
    if (disposed || blocked) {
      return { ok: false, reason: 'BLOCKED' };
    }
    if (!canEdit()) {
      return { ok: false, reason: 'READ_ONLY' };
    }
    const flushed = await flush();
    if (!flushed.ok) {
      return {
        ok: false,
        reason: flushed.reason || 'SESSION_FLUSH_FAILED',
        detail: flushed.saveError
      };
    }
    if (disposed || blocked || !canEdit()) {
      return { ok: false, reason: 'READ_ONLY' };
    }

    const workspace = getWorkspace();
    const planned = planImport({
      bundle,
      selection,
      library,
      state: workspace.state,
      evaluation: workspace.evaluation,
      view: workspace.view,
      limits: libraryLimits
    });
    if (!planned.ok) {
      return planned;
    }
    const plan = planned.plan;
    if (plan.noop) {
      return {
        ok: true,
        noop: true,
        addedDefinitionIds: [],
        skippedDefinitions: plan.skippedDefinitions,
        identicalDefinitionIds: plan.identicalDefinitionIds,
        drawing: null,
        drawingEmpty: plan.drawingEmpty,
        focusBounds: null,
        libraryRevision,
        sessionRevision: lastRevision
      };
    }

    busy = true;
    updateBanner();
    try {
      const result = await store.importWorkspace({
        tabId,
        instanceId,
        expectedSessionRevision: lastRevision,
        expectedLibraryRevision: libraryRevision,
        libraryDefinitions: plan.definitions,
        sessionState: plan.drawing ? plan.drawing.state : null,
        sessionEvaluation: plan.drawing ? plan.drawing.evaluation : null,
        sessionView: plan.drawing ? plan.drawing.view : null
      });
      if (!result.ok) {
        if (result.reason === 'NOT_OWNER') {
          loseOwnership('编辑权已被其他页面接管，导入未保存。');
        }
        return {
          ok: false,
          reason: result.reason,
          detail: result.detail,
          error: result.error
        };
      }
      if (result.library) {
        applyLibraryState(result.library.definitions, result.library.revision, {
          importedDefinitionIds: plan.addedDefinitionIds
        });
      }
      if (result.session) {
        lastRevision = result.session.revision;
        applyWorkspace({
          state: result.session.state,
          evaluation: result.session.evaluation,
          view: result.session.view
        }, { preserveClockRuntime: true });
        viewDirty = false;
      }
      saveError = null;
      broadcast('session-updated');
      return {
        ok: true,
        addedDefinitionIds: plan.addedDefinitionIds,
        skippedDefinitions: plan.skippedDefinitions,
        identicalDefinitionIds: plan.identicalDefinitionIds,
        drawing: plan.drawing ? { bounds: plan.drawing.bounds, anchor: plan.drawing.anchor } : null,
        drawingEmpty: plan.drawingEmpty,
        focusBounds: plan.focusBounds,
        noop: false,
        libraryRevision: result.libraryRevision,
        sessionRevision: result.sessionRevision
      };
    } finally {
      busy = false;
      updateBanner();
    }
  }

  function getLibrary() {
    return library;
  }

  function getLibraryRevision() {
    return libraryRevision;
  }

  function notifyCommit() {
    if (!canEdit()) {
      return;
    }
    cancelViewTimer();
    scheduleSave();
  }

  function notifyView() {
    if (!canEdit()) {
      return;
    }
    viewDirty = true;
    cancelViewTimer();
    viewTimer = setTimeoutFn(function () {
      viewTimer = null;
      if (canEdit()) {
        scheduleSave();
      }
    }, viewDebounceMs);
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    cancelPending();
    stopTimers();
    releaseLock();
    if (channel) {
      try {
        channel.close();
      } catch (error) {
        // Ignore.
      }
      channel = null;
    }
    if (owner) {
      void store.releaseOwnership({ tabId, instanceId });
      owner = false;
    }
  }

  function pagehide(event) {
    if (disposed) {
      return;
    }
    if (event && event.persisted) {
      stopTimers();
      void flush();
      return;
    }
    const finalize = function () {
      dispose();
    };
    if (owner && (pending || writing || viewTimer !== null || viewDirty)) {
      void flush().finally(finalize);
    } else {
      finalize();
    }
  }

  function resume() {
    if (disposed || blocked) {
      return;
    }
    startTimers();
    void checkOwner();
    updateBanner();
  }

  return {
    initialize,
    canEdit,
    isOwner: function () { return owner; },
    getStatus,
    notifyCommit,
    notifyView,
    requestNew,
    createDefinition,
    updateDefinition,
    deleteDefinition,
    previewImport,
    importBundle,
    getLibrary,
    getLibraryRevision,
    takeover,
    flush,
    retrySave,
    pagehide,
    resume,
    dispose
  };
}
