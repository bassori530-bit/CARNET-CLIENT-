// Remplace l'API window.storage (spécifique à l'environnement Claude Artifacts)
// par une vraie persistance locale dans le navigateur, via IndexedDB.
// Même interface : get / set / delete / list — le reste de l'app ne change pas.
(function () {
  const DB_NAME = "carnet-client-db";
  const STORE = "kv";
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function idbGet(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function idbSet(key, value) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbDelete(key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async function idbKeys() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  window.storage = {
    async get(key /* , shared */) {
      const value = await idbGet(key);
      if (value === undefined) return null;
      return { key, value, shared: false };
    },
    async set(key, value /* , shared */) {
      await idbSet(key, value);
      return { key, value, shared: false };
    },
    async delete(key /* , shared */) {
      await idbDelete(key);
      return { key, deleted: true, shared: false };
    },
    async list(prefix /* , shared */) {
      const allKeys = await idbKeys();
      const keys = prefix ? allKeys.filter((k) => k.startsWith(prefix)) : allKeys;
      return { keys, prefix, shared: false };
    },
  };
})();
