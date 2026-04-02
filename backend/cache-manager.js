import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve("data");
const DOCUMENTS_FILE = path.join(DATA_DIR, "documents.json");
const CACHE_INDEX_FILE = path.join(DATA_DIR, "cache-index.json");
const PAGE_CACHE_ROOT = path.resolve("pages-cache");

const DEFAULT_MAX_CACHE_BYTES = Number(process.env.CACHE_MAX_BYTES || String(1.5 * 1024 * 1024 * 1024));
const DEFAULT_MAX_CACHE_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES || "6000");

const ensureDirectory = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const readJsonFile = (filePath, fallback) => {
  try {
    if (!fs.existsSync(filePath)) {
      return fallback;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) {
      return fallback;
    }

    return JSON.parse(raw);
  } catch {
    return fallback;
  }
};

const writeJsonFile = async (filePath, value) => {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.tmp`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  await fs.promises.rename(tempPath, filePath);
};

export class CacheManager {
  constructor({ dataDir = DATA_DIR, pageCacheRoot = PAGE_CACHE_ROOT, maxCacheBytes = DEFAULT_MAX_CACHE_BYTES, maxCacheEntries = DEFAULT_MAX_CACHE_ENTRIES } = {}) {
    this.dataDir = dataDir;
    this.pageCacheRoot = pageCacheRoot;
    this.documentsFile = DOCUMENTS_FILE;
    this.cacheIndexFile = CACHE_INDEX_FILE;
    this.maxCacheBytes = maxCacheBytes;
    this.maxCacheEntries = maxCacheEntries;
    this.documents = new Map();
    this.cacheEntries = new Map();
    this.stats = {
      hits: 0,
      misses: 0,
      renders: 0,
      evictions: {
        entries: 0,
        bytes: 0
      }
    };
    this.renderSamples = [];
    this.persistTimer = null;
    this.load();
  }

  load() {
    ensureDirectory(this.dataDir);
    ensureDirectory(this.pageCacheRoot);

    const docs = readJsonFile(this.documentsFile, {});
    for (const [docId, documentRecord] of Object.entries(docs)) {
      this.documents.set(docId, documentRecord);
    }

    const index = readJsonFile(this.cacheIndexFile, {});
    const entries = index.entries || {};
    for (const [entryKey, entry] of Object.entries(entries)) {
      this.cacheEntries.set(entryKey, entry);
    }

    if (index.stats) {
      this.stats = {
        hits: Number(index.stats.hits || 0),
        misses: Number(index.stats.misses || 0),
        renders: Number(index.stats.renders || 0)
      };
      this.stats.evictions = {
        entries: Number(index.stats?.evictions?.entries || 0),
        bytes: Number(index.stats?.evictions?.bytes || 0)
      };
    }

    this.renderSamples = Array.isArray(index.renderSamples) ? index.renderSamples.slice(-200) : [];
  }

  getEntryKey(docId, pageNumber, quality) {
    return `${docId}:${pageNumber}_${quality}`;
  }

  getDocument(docId) {
    return this.documents.get(docId) || null;
  }

  listDocuments() {
    return Array.from(this.documents.values());
  }

  registerDocument(documentRecord) {
    const now = Date.now();
    const next = {
      docId: documentRecord.docId,
      filePath: documentRecord.filePath,
      originalName: documentRecord.originalName,
      pageCount: documentRecord.pageCount,
      dimensions: documentRecord.dimensions || null,
      size: documentRecord.size || 0,
      status: documentRecord.status || "ready_partial",
      renderMode: documentRecord.renderMode || "server-images",
      pagesPath: documentRecord.pagesPath || `/page/${documentRecord.docId}`,
      pagesRendered: documentRecord.pagesRendered || 0,
      pagesRenderedLow: documentRecord.pagesRenderedLow || 0,
      pagesRenderedHigh: documentRecord.pagesRenderedHigh || 0,
      lastAccessTime: documentRecord.lastAccessTime || now,
      createdAt: documentRecord.createdAt || now,
      error: documentRecord.error || null
    };

    this.documents.set(next.docId, next);
    this.schedulePersist();
    return next;
  }

  updateDocument(docId, patch) {
    const current = this.documents.get(docId);
    if (!current) {
      return null;
    }

    const next = {
      ...current,
      ...patch,
      lastAccessTime: Date.now()
    };
    this.documents.set(docId, next);
    this.schedulePersist();
    return next;
  }

  touchDocument(docId) {
    const current = this.documents.get(docId);
    if (!current) {
      return null;
    }
    current.lastAccessTime = Date.now();
    this.documents.set(docId, current);
    this.schedulePersist();
    return current;
  }

  getCacheDir(docId, quality) {
    return path.join(this.pageCacheRoot, docId, quality);
  }

  getCachedEntry(docId, pageNumber, quality) {
    const entryKey = this.getEntryKey(docId, pageNumber, quality);
    const entry = this.cacheEntries.get(entryKey);
    if (!entry || !entry.filePath || !fs.existsSync(entry.filePath)) {
      if (entry) {
        this.cacheEntries.delete(entryKey);
        this.schedulePersist();
      }
      return null;
    }

    entry.lastAccessTime = Date.now();
    this.cacheEntries.set(entryKey, entry);
    const documentRecord = this.documents.get(docId);
    if (documentRecord) {
      documentRecord.lastAccessTime = Date.now();
      this.documents.set(docId, documentRecord);
    }
    this.stats.hits += 1;
    this.schedulePersist();
    return entry;
  }

  recordCacheMiss() {
    this.stats.misses += 1;
    this.schedulePersist();
  }

  recordRender(docId, pageNumber, quality, filePath, sizeBytes) {
    const now = Date.now();
    const entryKey = this.getEntryKey(docId, pageNumber, quality);
    const entry = {
      docId,
      pageNumber,
      quality,
      filePath,
      sizeBytes,
      lastAccessTime: now,
      createdAt: now
    };
    this.cacheEntries.set(entryKey, entry);

    const documentRecord = this.documents.get(docId);
    if (documentRecord) {
      const next = { ...documentRecord };
      next.pagesRendered = Number(next.pagesRendered || 0) + 1;
      if (quality === "low") {
        next.pagesRenderedLow = Number(next.pagesRenderedLow || 0) + 1;
      } else {
        next.pagesRenderedHigh = Number(next.pagesRenderedHigh || 0) + 1;
      }
      next.lastAccessTime = now;
      this.documents.set(docId, next);
    }

    this.stats.renders += 1;
    this.schedulePersist();
  }

  observeRenderTime(sample) {
    this.renderSamples.push({
      docId: sample.docId,
      pageNumber: sample.pageNumber,
      quality: sample.quality,
      elapsedMs: Number(sample.elapsedMs || 0),
      createdAt: Date.now()
    });

    if (this.renderSamples.length > 200) {
      this.renderSamples.splice(0, this.renderSamples.length - 200);
    }

    this.schedulePersist();
  }

  recordEviction(entry, reason) {
    if (reason === "bytes") {
      this.stats.evictions.bytes += 1;
    } else {
      this.stats.evictions.entries += 1;
    }

    if (entry?.docId) {
      const documentRecord = this.documents.get(entry.docId);
      if (documentRecord) {
        documentRecord.lastAccessTime = Date.now();
        this.documents.set(entry.docId, documentRecord);
      }
    }

    this.schedulePersist();
  }

  getTimingSummary() {
    const summarize = (quality) => {
      const samples = this.renderSamples.filter((sample) => sample.quality === quality).map((sample) => sample.elapsedMs).sort((a, b) => a - b);
      if (samples.length === 0) {
        return { p50: 0, p95: 0, count: 0 };
      }

      const p50 = samples[Math.floor((samples.length - 1) * 0.5)];
      const p95 = samples[Math.floor((samples.length - 1) * 0.95)];
      return { p50, p95, count: samples.length };
    };

    return {
      low: summarize("low"),
      high: summarize("high")
    };
  }

  getStats() {
    const uniquePages = this.cacheEntries.size;
    const renderPerPageRatio = uniquePages > 0 ? this.stats.renders / uniquePages : 0;
    const evictions = this.stats.evictions || { entries: 0, bytes: 0 };

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      renders: this.stats.renders,
      uniquePages,
      renderPerPageRatio,
      evictions,
      entries: this.cacheEntries.size,
      bytes: this.getTotalCacheBytes()
    };
  }

  getTotalCacheBytes() {
    let total = 0;
    for (const entry of this.cacheEntries.values()) {
      total += Number(entry.sizeBytes || 0);
    }
    return total;
  }

  async evictIfNeeded({ activeDocId } = {}) {
    let changed = false;
    const orderedEntries = Array.from(this.cacheEntries.entries()).sort((a, b) => {
      const aActive = activeDocId && a[1].docId === activeDocId ? 1 : 0;
      const bActive = activeDocId && b[1].docId === activeDocId ? 1 : 0;
      if (aActive !== bActive) {
        return aActive - bActive;
      }
      return Number(a[1].lastAccessTime || 0) - Number(b[1].lastAccessTime || 0);
    });

    let totalBytes = this.getTotalCacheBytes();
    while (orderedEntries.length > this.maxCacheEntries || totalBytes > this.maxCacheBytes) {
      const [entryKey, entry] = orderedEntries.shift();
      if (!entry) {
        break;
      }

      try {
        if (entry.filePath && fs.existsSync(entry.filePath)) {
          await fs.promises.unlink(entry.filePath);
        }
      } catch {
        // Ignore eviction cleanup failures.
      }

      totalBytes -= Number(entry.sizeBytes || 0);
      this.cacheEntries.delete(entryKey);
      this.recordEviction(entry, totalBytes > this.maxCacheBytes ? "bytes" : "entries");
      changed = true;
    }

    if (changed) {
      this.schedulePersist();
    }
  }

  async persistNow() {
    await writeJsonFile(this.documentsFile, Object.fromEntries(this.documents.entries()));
    await writeJsonFile(this.cacheIndexFile, {
      stats: this.stats,
      entries: Object.fromEntries(this.cacheEntries.entries()),
      renderSamples: this.renderSamples
    });
  }

  schedulePersist() {
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(async () => {
      this.persistTimer = null;
      try {
        await this.persistNow();
      } catch {
        // Persistence should never crash the request path.
      }
    }, 250);
  }
}

export const cacheManager = new CacheManager();
