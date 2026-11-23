/**
 * js/storage.js — IndexedDB Persistence Layer for CLIPZONE AI — Creator Studio
 */
export class StorageEngine {
  constructor(options = {}) {
    this.dbName = options.dbName || 'ClipZoneAI_StudioDB';
    this.version = options.version || 2;
    this.storeName = 'projects';
    this.db = null;
    this.onLog = options.onLog || (() => {});
  }

  async init() {
    if (this.db) return this.db;
    if (!('indexedDB' in window)) {
      throw new Error('IndexedDB is not supported in this browser.');
    }

    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this.dbName, this.version);

      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
          store.createIndex('updatedAt', 'updatedAt', { unique: false });
        }
      };

      req.onsuccess = (event) => {
        this.db = event.target.result;
        this.db.onversionchange = () => {
          this.db.close();
          this.db = null;
        };
        resolve(this.db);
      };

      req.onerror = (event) => {
        reject(new Error(`Failed to open IndexedDB: ${event.target.error?.message || event.target.error}`));
      };
    });
  }

  async getQuotaEstimate() {
    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
      try {
        return await navigator.storage.estimate();
      } catch (_) {
        return null;
      }
    }
    return null;
  }

  async saveProject(project) {
    await this.init();

    const estimatedBytes = project.videoBlob ? project.videoBlob.size : 0;
    const quota = await this.getQuotaEstimate();
    if (quota && typeof quota.quota === 'number' && typeof quota.usage === 'number') {
      const remaining = quota.quota - quota.usage;
      if (estimatedBytes > 0 && remaining > 0 && estimatedBytes > remaining * 0.9) {
        throw new Error(
          `Storage quota too low for video (${(estimatedBytes / (1024 * 1024)).toFixed(1)} MB needed, ${(remaining / (1024 * 1024)).toFixed(1)} MB remaining). Delete old projects first.`
        );
      }
    }

    const record = {
      id: project.id || `cz-${Date.now()}`,
      title: project.title || 'ClipZone Project',
      fileName: project.fileName || 'video.mp4',
      videoBlob: project.videoBlob || null,
      updatedAt: project.updatedAt || Date.now(),
      state: project.state || {}
    };

    try {
      return await new Promise((resolve, reject) => {
        const tx = this.db.transaction(this.storeName, 'readwrite');
        const store = tx.objectStore(this.storeName);
        const putReq = store.put(record);
        putReq.onsuccess = () => {
          this.onLog(`Saved project "${record.title}" to IndexedDB.`);
          resolve(record);
        };
        putReq.onerror = (e) => {
          reject(new Error(`IndexedDB write failed: ${e.target.error?.message || e.target.error}`));
        };
      });
    } catch (err) {
      if (err.name === 'QuotaExceededError') {
        throw new Error('Browser storage quota exceeded. Delete saved projects to free space.');
      }
      throw err;
    }
  }

  async loadProject(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(new Error(`Failed to load project: ${e.target.error?.message || e.target.error}`));
    });
  }

  async listProjects() {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      const req = store.getAll();
      req.onsuccess = () => {
        const list = (req.result || [])
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .map(({ id, title, fileName, updatedAt }) => ({ id, title, fileName, updatedAt }));
        resolve(list);
      };
      req.onerror = (e) => reject(new Error(`Failed to list projects: ${e.target.error?.message || e.target.error}`));
    });
  }

  async deleteProject(id) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      const req = store.delete(id);
      req.onsuccess = () => {
        this.onLog(`Deleted project ${id}.`);
        resolve(true);
      };
      req.onerror = (e) => reject(new Error(`Failed to delete project: ${e.target.error?.message || e.target.error}`));
    });
  }
}
