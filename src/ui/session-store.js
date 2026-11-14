// 单 Session IndexedDB 存储：记录、写入版本和编辑所有权。
// 所有权记录使用租约；Web Locks / BroadcastChannel 由 session-controller 负责，
// 真正的旧写入防护由这里的 readwrite 事务检查 owner + revision 完成。
export const SESSION_SCHEMA_VERSION = 3;
export const LIBRARY_SCHEMA_VERSION = 1;
export const SESSION_DB_NAME = 'my-circuit-session';
export const SESSION_STORE = 'session';
export const OWNER_LEASE_MS = 6000;

const SESSION_KEY = 'session';
const LIBRARY_KEY = 'library';
const OWNER_KEY = 'owner';

function errorInfo(error) {
  if (!error) {
    return { name: 'Error', message: 'unknown IndexedDB error' };
  }
  return {
    name: error.name || 'Error',
    message: error.message || String(error)
  };
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInteger(value) {
  return Number.isInteger(value);
}

export function createSessionStore(options = {}) {
  const factory = options.indexedDB || (typeof indexedDB !== 'undefined' ? indexedDB : null);
  const dbName = options.dbName || SESSION_DB_NAME;
  const now = options.now || Date.now;
  const leaseMs = options.leaseMs || OWNER_LEASE_MS;
  let db = null;
  let opening = null;

  function open() {
    if (db) {
      return Promise.resolve({ ok: true });
    }
    if (opening) {
      return opening;
    }
    if (!factory || typeof factory.open !== 'function') {
      opening = Promise.resolve({ ok: false, error: { name: 'IDB_UNAVAILABLE', message: 'IndexedDB is unavailable' } });
      return opening;
    }
    opening = new Promise(function (resolve) {
      let request;
      try {
        request = factory.open(dbName, 1);
      } catch (error) {
        opening = null;
        resolve({ ok: false, error: errorInfo(error) });
        return;
      }
      request.onupgradeneeded = function () {
        const database = request.result;
        if (!database.objectStoreNames.contains(SESSION_STORE)) {
          database.createObjectStore(SESSION_STORE);
        }
      };
      request.onsuccess = function () {
        db = request.result;
        db.onversionchange = function () {
          try {
            db.close();
          } catch (error) {
            // Ignore close errors.
          }
          db = null;
          opening = null;
        };
        resolve({ ok: true });
      };
      request.onerror = function () {
        opening = null;
        resolve({ ok: false, error: errorInfo(request.error) });
      };
    });
    return opening;
  }

  function readKey(key) {
    return open().then(function (opened) {
      if (!opened.ok) {
        return opened;
      }
      return new Promise(function (resolve) {
        let transaction;
        try {
          transaction = db.transaction(SESSION_STORE, 'readonly');
        } catch (error) {
          resolve({ ok: false, error: errorInfo(error) });
          return;
        }
        let value;
        let failure = null;
        const request = transaction.objectStore(SESSION_STORE).get(key);
        request.onsuccess = function () {
          value = request.result;
        };
        request.onerror = function () {
          failure = request.error;
        };
        transaction.oncomplete = function () {
          if (failure) {
            resolve({ ok: false, error: errorInfo(failure) });
          } else {
            resolve({ ok: true, value });
          }
        };
        transaction.onerror = function () {
          resolve({ ok: false, error: errorInfo(transaction.error || failure) });
        };
        transaction.onabort = function () {
          resolve({ ok: false, error: errorInfo(transaction.error || failure) });
        };
      });
    });
  }

  function write(mutator) {
    return open().then(function (opened) {
      if (!opened.ok) {
        return opened;
      }
      return new Promise(function (resolve) {
        let transaction;
        try {
          transaction = db.transaction(SESSION_STORE, 'readwrite');
        } catch (error) {
          resolve({ ok: false, error: errorInfo(error) });
          return;
        }
        let result = null;
        function settle(value) {
          if (result === null) {
            result = value;
          }
        }
        transaction.oncomplete = function () {
          resolve(result || { ok: true });
        };
        function abortResult() {
          if (result && result.ok === false) {
            resolve(result);
          } else {
            resolve({ ok: false, error: errorInfo(transaction.error) });
          }
        }
        transaction.onerror = abortResult;
        transaction.onabort = abortResult;
        try {
          mutator(transaction.objectStore(SESSION_STORE), transaction, settle);
        } catch (error) {
          settle({ ok: false, error: errorInfo(error) });
          try {
            transaction.abort();
          } catch (abortError) {
            // Ignore abort errors after a failed mutation.
          }
        }
      });
    });
  }

  function readSession() {
    return readKey(SESSION_KEY);
  }

  function readLibrary() {
    return readKey(LIBRARY_KEY);
  }

  // 同一 readonly 事务读取库与 Session，避免两次读取跨越库写入。
  function readWorkspaceBundle() {
    return open().then(function (opened) {
      if (!opened.ok) {
        return opened;
      }
      return new Promise(function (resolve) {
        let transaction;
        try {
          transaction = db.transaction(SESSION_STORE, 'readonly');
        } catch (error) {
          resolve({ ok: false, error: errorInfo(error) });
          return;
        }
        const store = transaction.objectStore(SESSION_STORE);
        let library;
        let session;
        let failure = null;
        const libraryRequest = store.get(LIBRARY_KEY);
        libraryRequest.onsuccess = function () { library = libraryRequest.result; };
        libraryRequest.onerror = function () { failure = libraryRequest.error; };
        const sessionRequest = store.get(SESSION_KEY);
        sessionRequest.onsuccess = function () { session = sessionRequest.result; };
        sessionRequest.onerror = function () { failure = sessionRequest.error; };
        transaction.oncomplete = function () {
          if (failure) {
            resolve({ ok: false, error: errorInfo(failure) });
          } else {
            resolve({ ok: true, library, session });
          }
        };
        transaction.onerror = function () {
          resolve({ ok: false, error: errorInfo(transaction.error || failure) });
        };
        transaction.onabort = function () {
          resolve({ ok: false, error: errorInfo(transaction.error || failure) });
        };
      });
    });
  }

  function readOwner() {
    return readKey(OWNER_KEY);
  }

  function claimOwnership(input) {
    const tabId = input && input.tabId;
    const instanceId = input && input.instanceId;
    const takeover = Boolean(input && input.takeover);
    if (typeof tabId !== 'string' || !tabId || typeof instanceId !== 'string' || !instanceId) {
      return Promise.resolve({ ok: false, reason: 'INVALID_OWNER' });
    }
    return write(function (store, transaction, settle) {
      const request = store.get(OWNER_KEY);
      request.onsuccess = function () {
        const owner = request.result;
        const currentTime = now();
        const active = Boolean(owner) && isInteger(owner.expiresAt) && owner.expiresAt > currentTime;
        const sameTab = Boolean(owner) && owner.tabId === tabId;
        if (active && !sameTab && !takeover) {
          settle({ ok: false, reason: 'OWNED', owner });
          transaction.abort();
          return;
        }
        const next = {
          tabId,
          instanceId,
          expiresAt: currentTime + leaseMs,
          epoch: owner && isInteger(owner.epoch) ? owner.epoch + 1 : 1
        };
        try {
          store.put(next, OWNER_KEY);
          settle({ ok: true, owner: next, previousOwner: owner || null });
        } catch (error) {
          settle({ ok: false, error: errorInfo(error) });
          try { transaction.abort(); } catch (abortError) { /* ignore */ }
        }
      };
      request.onerror = function () {
        settle({ ok: false, error: errorInfo(request.error) });
        transaction.abort();
      };
    });
  }

  function renewOwnership(input) {
    const tabId = input && input.tabId;
    const instanceId = input && input.instanceId;
    return write(function (store, transaction, settle) {
      const request = store.get(OWNER_KEY);
      request.onsuccess = function () {
        const owner = request.result;
        if (!owner || owner.tabId !== tabId || owner.instanceId !== instanceId) {
          settle({ ok: false, reason: 'NOT_OWNER', owner: owner || null });
          transaction.abort();
          return;
        }
        const next = Object.assign({}, owner, { expiresAt: now() + leaseMs });
        try {
          store.put(next, OWNER_KEY);
          settle({ ok: true, owner: next });
        } catch (error) {
          settle({ ok: false, error: errorInfo(error) });
          try { transaction.abort(); } catch (abortError) { /* ignore */ }
        }
      };
      request.onerror = function () {
        settle({ ok: false, error: errorInfo(request.error) });
        transaction.abort();
      };
    });
  }

  function releaseOwnership(input) {
    const tabId = input && input.tabId;
    const instanceId = input && input.instanceId;
    return write(function (store, transaction, settle) {
      const request = store.get(OWNER_KEY);
      request.onsuccess = function () {
        const owner = request.result;
        if (owner && owner.tabId === tabId && owner.instanceId === instanceId) {
          try {
            store.delete(OWNER_KEY);
            settle({ ok: true, released: true });
          } catch (error) {
            settle({ ok: false, error: errorInfo(error) });
            try { transaction.abort(); } catch (abortError) { /* ignore */ }
          }
        } else {
          settle({ ok: true, released: false });
        }
      };
      request.onerror = function () {
        settle({ ok: false, error: errorInfo(request.error) });
        transaction.abort();
      };
    });
  }

  function saveSession(input) {
    const tabId = input && input.tabId;
    const instanceId = input && input.instanceId;
    const expectedRevision = input && input.expectedRevision;
    if (!isObject(input) || !isInteger(expectedRevision) || expectedRevision < 0) {
      return Promise.resolve({ ok: false, reason: 'INVALID_REVISION' });
    }
    return write(function (store, transaction, settle) {
      let session;
      let owner;
      let sessionReady = false;
      let ownerReady = false;
      function check() {
        if (!sessionReady || !ownerReady) {
          return;
        }
        if (!owner || owner.tabId !== tabId || owner.instanceId !== instanceId) {
          settle({ ok: false, reason: 'NOT_OWNER', owner: owner || null });
          transaction.abort();
          return;
        }
        const currentRevision = session && isInteger(session.revision) ? session.revision : 0;
        if (currentRevision !== expectedRevision) {
          settle({ ok: false, reason: 'REVISION', latestRevision: currentRevision });
          transaction.abort();
          return;
        }
        const next = {
          schemaVersion: SESSION_SCHEMA_VERSION,
          revision: currentRevision + 1,
          writerId: tabId,
          writerInstance: instanceId,
          savedAt: now(),
          state: input.state,
          evaluation: input.evaluation,
          view: input.view
        };
        try {
          store.put(next, SESSION_KEY);
          store.put(Object.assign({}, owner, { expiresAt: now() + leaseMs }), OWNER_KEY);
          settle({ ok: true, revision: next.revision, savedAt: next.savedAt });
        } catch (error) {
          settle({ ok: false, error: errorInfo(error) });
          try { transaction.abort(); } catch (abortError) { /* ignore */ }
        }
      }
      const sessionRequest = store.get(SESSION_KEY);
      sessionRequest.onsuccess = function () {
        session = sessionRequest.result;
        sessionReady = true;
        check();
      };
      sessionRequest.onerror = function () {
        settle({ ok: false, error: errorInfo(sessionRequest.error) });
        transaction.abort();
      };
      const ownerRequest = store.get(OWNER_KEY);
      ownerRequest.onsuccess = function () {
        owner = ownerRequest.result;
        ownerReady = true;
        check();
      };
      ownerRequest.onerror = function () {
        settle({ ok: false, error: errorInfo(ownerRequest.error) });
        transaction.abort();
      };
    });
  }

  function clearSession(input) {
    const tabId = input && input.tabId;
    const instanceId = input && input.instanceId;
    return write(function (store, transaction, settle) {
      const request = store.get(OWNER_KEY);
      request.onsuccess = function () {
        const owner = request.result;
        if (!owner || owner.tabId !== tabId || owner.instanceId !== instanceId) {
          settle({ ok: false, reason: 'NOT_OWNER', owner: owner || null });
          transaction.abort();
          return;
        }
        try {
          store.delete(SESSION_KEY);
          settle({ ok: true });
        } catch (error) {
          settle({ ok: false, error: errorInfo(error) });
          try { transaction.abort(); } catch (abortError) { /* ignore */ }
        }
      };
      request.onerror = function () {
        settle({ ok: false, error: errorInfo(request.error) });
        transaction.abort();
      };
    });
  }

  // 元件库写入：同一 readwrite 事务读取 owner/library/session，检查 owner 与
  // library revision 后执行同步 mutator。mutator 失败或抛错时 abort，旧记录不变。
  function mutateLibrary(input) {
    const tabId = input && input.tabId;
    const instanceId = input && input.instanceId;
    const expectedRevision = input && input.expectedRevision;
    const mutate = input && input.mutate;
    if (!isObject(input) || !isInteger(expectedRevision) || expectedRevision < 0 ||
        typeof mutate !== 'function') {
      return Promise.resolve({ ok: false, reason: 'INVALID_LIBRARY_INPUT' });
    }
    return write(function (store, transaction, settle) {
      let owner;
      let library;
      let session;
      let ownerReady = false;
      let libraryReady = false;
      let sessionReady = false;

      function fail(reason, detail) {
        settle({ ok: false, reason, detail });
        transaction.abort();
      }

      function check() {
        if (!ownerReady || !libraryReady || !sessionReady) return;
        if (!owner || owner.tabId !== tabId || owner.instanceId !== instanceId) {
          fail('NOT_OWNER', owner || null);
          return;
        }
        if (library && library.schemaVersion !== LIBRARY_SCHEMA_VERSION) {
          fail('INCOMPATIBLE_LIBRARY');
          return;
        }
        if (library && !isObject(library.definitions)) {
          fail('CORRUPT_LIBRARY');
          return;
        }
        if (library && (!isInteger(library.revision) || library.revision < 0)) {
          fail('CORRUPT_LIBRARY');
          return;
        }
        if (session && session.schemaVersion !== SESSION_SCHEMA_VERSION) {
          fail('INCOMPATIBLE_SESSION');
          return;
        }
        if (session && !isObject(session.state)) {
          fail('CORRUPT_SESSION');
          return;
        }
        const currentRevision = library && isInteger(library.revision) ? library.revision : 0;
        if (currentRevision !== expectedRevision) {
          settle({ ok: false, reason: 'REVISION', latestRevision: currentRevision });
          transaction.abort();
          return;
        }
        const currentDefinitions = library && isObject(library.definitions)
          ? library.definitions
          : {};
        let mutation;
        try {
          mutation = mutate({ library: { definitions: currentDefinitions }, session: session || null });
        } catch (error) {
          settle({ ok: false, error: errorInfo(error) });
          try { transaction.abort(); } catch (abortError) { /* ignore */ }
          return;
        }
        if (!mutation || mutation.ok !== true || !isObject(mutation.definitions)) {
          settle({
            ok: false,
            reason: mutation && mutation.reason || 'LIBRARY_REJECTED',
            detail: mutation && mutation.detail,
            references: mutation && mutation.references
          });
          transaction.abort();
          return;
        }
        const next = {
          schemaVersion: LIBRARY_SCHEMA_VERSION,
          revision: currentRevision + 1,
          definitions: mutation.definitions,
          savedAt: now()
        };
        try {
          store.put(next, LIBRARY_KEY);
          store.put(Object.assign({}, owner, { expiresAt: now() + leaseMs }), OWNER_KEY);
          settle({ ok: true, revision: next.revision, library: next });
        } catch (error) {
          settle({ ok: false, error: errorInfo(error) });
          try { transaction.abort(); } catch (abortError) { /* ignore */ }
        }
      }

      const ownerRequest = store.get(OWNER_KEY);
      ownerRequest.onsuccess = function () {
        owner = ownerRequest.result;
        ownerReady = true;
        check();
      };
      ownerRequest.onerror = function () {
        settle({ ok: false, error: errorInfo(ownerRequest.error) });
        transaction.abort();
      };
      const libraryRequest = store.get(LIBRARY_KEY);
      libraryRequest.onsuccess = function () {
        library = libraryRequest.result;
        libraryReady = true;
        check();
      };
      libraryRequest.onerror = function () {
        settle({ ok: false, error: errorInfo(libraryRequest.error) });
        transaction.abort();
      };
      const sessionRequest = store.get(SESSION_KEY);
      sessionRequest.onsuccess = function () {
        session = sessionRequest.result;
        sessionReady = true;
        check();
      };
      sessionRequest.onerror = function () {
        settle({ ok: false, error: errorInfo(sessionRequest.error) });
        transaction.abort();
      };
    });
  }

  // 导入的工作区快照与元件库必须在同一事务写入，避免定义已写入而主图纸失败。
  // 只写实际变化的部分：libraryDefinitions 为 null 时不写库，sessionState 为 null 时不写 Session。
  function importWorkspace(input) {
    const tabId = input && input.tabId;
    const instanceId = input && input.instanceId;
    const expectedSessionRevision = input && input.expectedSessionRevision;
    const expectedLibraryRevision = input && input.expectedLibraryRevision;
    const writeLibrary = Boolean(input) && input.libraryDefinitions !== null &&
      input.libraryDefinitions !== undefined;
    const writeSession = Boolean(input) && input.sessionState !== null &&
      input.sessionState !== undefined;
    if (!isObject(input) || !isInteger(expectedSessionRevision) || expectedSessionRevision < 0 ||
        !isInteger(expectedLibraryRevision) || expectedLibraryRevision < 0 ||
        (!writeLibrary && !writeSession)) {
      return Promise.resolve({ ok: false, reason: 'INVALID_IMPORT_INPUT' });
    }
    if (writeLibrary && !isObject(input.libraryDefinitions)) {
      return Promise.resolve({ ok: false, reason: 'INVALID_IMPORT_INPUT', detail: 'libraryDefinitions' });
    }
    if (writeSession && (!isObject(input.sessionState) ||
        !isObject(input.sessionEvaluation) || !isObject(input.sessionView))) {
      return Promise.resolve({ ok: false, reason: 'INVALID_IMPORT_INPUT', detail: 'sessionState' });
    }
    return write(function (store, transaction, settle) {
      let owner;
      let session;
      let library;
      let ownerReady = false;
      let sessionReady = false;
      let libraryReady = false;

      function fail(reason, detail) {
        settle({ ok: false, reason, detail });
        transaction.abort();
      }

      function check() {
        if (!ownerReady || !sessionReady || !libraryReady) {
          return;
        }
        if (!owner || owner.tabId !== tabId || owner.instanceId !== instanceId) {
          fail('NOT_OWNER', owner || null);
          return;
        }
        if (library && library.schemaVersion !== LIBRARY_SCHEMA_VERSION) {
          fail('INCOMPATIBLE_LIBRARY');
          return;
        }
        if (library && (!isObject(library.definitions) ||
            !isInteger(library.revision) || library.revision < 0)) {
          fail('CORRUPT_LIBRARY');
          return;
        }
        if (session && session.schemaVersion !== SESSION_SCHEMA_VERSION) {
          fail('INCOMPATIBLE_SESSION');
          return;
        }
        if (session && (!isObject(session.state) || !isInteger(session.revision) || session.revision < 0)) {
          fail('CORRUPT_SESSION');
          return;
        }
        const currentLibraryRevision = library && isInteger(library.revision) ? library.revision : 0;
        if (currentLibraryRevision !== expectedLibraryRevision) {
          settle({ ok: false, reason: 'REVISION', detail: 'library', latestRevision: currentLibraryRevision });
          transaction.abort();
          return;
        }
        const currentSessionRevision = session && isInteger(session.revision) ? session.revision : 0;
        if (currentSessionRevision !== expectedSessionRevision) {
          settle({ ok: false, reason: 'REVISION', detail: 'session', latestRevision: currentSessionRevision });
          transaction.abort();
          return;
        }

        let nextLibrary = null;
        let nextSession = null;
        try {
          if (writeLibrary) {
            nextLibrary = {
              schemaVersion: LIBRARY_SCHEMA_VERSION,
              revision: currentLibraryRevision + 1,
              definitions: input.libraryDefinitions,
              savedAt: now()
            };
            store.put(nextLibrary, LIBRARY_KEY);
          }
          if (writeSession) {
            nextSession = {
              schemaVersion: SESSION_SCHEMA_VERSION,
              revision: currentSessionRevision + 1,
              writerId: tabId,
              writerInstance: instanceId,
              savedAt: now(),
              state: input.sessionState,
              evaluation: input.sessionEvaluation,
              view: input.sessionView
            };
            store.put(nextSession, SESSION_KEY);
          }
          store.put(Object.assign({}, owner, { expiresAt: now() + leaseMs }), OWNER_KEY);
          settle({
            ok: true,
            libraryRevision: nextLibrary ? nextLibrary.revision : currentLibraryRevision,
            sessionRevision: nextSession ? nextSession.revision : currentSessionRevision,
            library: nextLibrary,
            session: nextSession
          });
        } catch (error) {
          settle({ ok: false, error: errorInfo(error) });
          try { transaction.abort(); } catch (abortError) { /* ignore */ }
        }
      }

      const ownerRequest = store.get(OWNER_KEY);
      ownerRequest.onsuccess = function () {
        owner = ownerRequest.result;
        ownerReady = true;
        check();
      };
      ownerRequest.onerror = function () {
        settle({ ok: false, error: errorInfo(ownerRequest.error) });
        transaction.abort();
      };
      const libraryRequest = store.get(LIBRARY_KEY);
      libraryRequest.onsuccess = function () {
        library = libraryRequest.result;
        libraryReady = true;
        check();
      };
      libraryRequest.onerror = function () {
        settle({ ok: false, error: errorInfo(libraryRequest.error) });
        transaction.abort();
      };
      const sessionRequest = store.get(SESSION_KEY);
      sessionRequest.onsuccess = function () {
        session = sessionRequest.result;
        sessionReady = true;
        check();
      };
      sessionRequest.onerror = function () {
        settle({ ok: false, error: errorInfo(sessionRequest.error) });
        transaction.abort();
      };
    });
  }

  // 仅用于显式放弃不兼容/损坏的本地开发数据。普通读取失败、abort 或所有权
  // 冲突不会调用本函数。
  function clearWorkspace(input) {
    const tabId = input && input.tabId;
    const instanceId = input && input.instanceId;
    const clearLibrary = Boolean(input && input.library);
    const clearSessionKey = Boolean(input && input.session);
    return write(function (store, transaction, settle) {
      const request = store.get(OWNER_KEY);
      request.onsuccess = function () {
        const owner = request.result;
        if (!owner || owner.tabId !== tabId || owner.instanceId !== instanceId) {
          settle({ ok: false, reason: 'NOT_OWNER', owner: owner || null });
          transaction.abort();
          return;
        }
        try {
          if (clearLibrary) store.delete(LIBRARY_KEY);
          if (clearSessionKey) store.delete(SESSION_KEY);
          settle({ ok: true });
        } catch (error) {
          settle({ ok: false, error: errorInfo(error) });
          try { transaction.abort(); } catch (abortError) { /* ignore */ }
        }
      };
      request.onerror = function () {
        settle({ ok: false, error: errorInfo(request.error) });
        transaction.abort();
      };
    });
  }

  function close() {
    if (db) {
      try {
        db.close();
      } catch (error) {
        // Ignore.
      }
    }
    db = null;
    opening = null;
  }

  return {
    dbName,
    leaseMs,
    open,
    close,
    readSession,
    readLibrary,
    readWorkspaceBundle,
    readOwner,
    claimOwnership,
    renewOwnership,
    releaseOwnership,
    saveSession,
    clearSession,
    mutateLibrary,
    importWorkspace,
    clearWorkspace
  };
}
