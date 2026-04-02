import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import pdfParse from "pdf-parse";
import { cacheManager } from "./cache-manager.js";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.PORT || 4000);
const AUTO_KILL_PREVIOUS = process.env.AUTO_KILL_PREVIOUS === "1";
const uploadsDir = path.resolve("uploads");
const pageCacheDir = path.resolve("pages-cache");
const dataDir = path.resolve("data");

const MAX_UPLOAD_PAGES = Number(process.env.MAX_UPLOAD_PAGES || "10000");
const MAX_ACTIVE_RENDER_JOBS = Number(process.env.BACKEND_RENDER_CONCURRENCY || "2");
const MAX_QUEUE_LENGTH = Number(process.env.BACKEND_RENDER_QUEUE_LENGTH || "10");

for (const dir of [uploadsDir, pageCacheDir, dataDir]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".pdf");
    cb(null, `${randomUUID()}${ext.toLowerCase() || ".pdf"}`);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 80 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    const byMime = file.mimetype === "application/pdf";
    const byName = typeof file.originalname === "string" && file.originalname.toLowerCase().endsWith(".pdf");
    cb(byMime || byName ? null : new Error("Only PDF files are allowed"), byMime || byName);
  }
});

const renderQueue = [];
const pendingRenderPromises = new Map();
let activeRenderJobs = 0;
let serverInstance = null;

const PRIORITY = {
  current: 0,
  adjacent: 1,
  buffer: 2
};

const normalizePriority = (priority, pageNumber, quality) => {
  if (priority === "current" || priority === 0 || priority === "0") {
    return PRIORITY.current;
  }

  if (priority === "adjacent" || priority === 1 || priority === "1") {
    return PRIORITY.adjacent;
  }

  if (priority === "buffer" || priority === 2 || priority === "2") {
    return PRIORITY.buffer;
  }

  if (pageNumber === 1) {
    return PRIORITY.current;
  }

  return quality === "low" ? PRIORITY.buffer : PRIORITY.adjacent;
};

const detectCommand = (command, args) =>
  new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: "ignore" });
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });

const popplerAvailablePromise = detectCommand("pdftoppm", ["-h"]);
const pdfInfoAvailablePromise = detectCommand("pdfinfo", ["-v"]);

const resolvePageImagePath = (qualityDir, pageNumber) => {
  const exact = path.join(qualityDir, `page-${pageNumber}.jpg`);
  if (fs.existsSync(exact)) {
    return exact;
  }

  for (let width = 2; width <= 8; width += 1) {
    const padded = path.join(qualityDir, `page-${String(pageNumber).padStart(width, "0")}.jpg`);
    if (fs.existsSync(padded)) {
      return padded;
    }
  }

  return null;
};

const runPdfToPpm = (args) =>
  new Promise((resolve, reject) => {
    const proc = spawn("pdftoppm", args, { stdio: "ignore" });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pdftoppm failed with code ${code}`));
    });
  });

const ensureDirectory = (directoryPath) => {
  if (!fs.existsSync(directoryPath)) {
    fs.mkdirSync(directoryPath, { recursive: true });
  }
};

const parsePdfInfoOutput = (output) => {
  const pagesMatch = output.match(/^Pages:\s+(\d+)/m);
  const sizeMatch = output.match(/^Page size:\s+([\d.]+)\s+x\s+([\d.]+)\s+pts/m);

  return {
    pageCount: pagesMatch ? Number(pagesMatch[1]) : null,
    dimensions: sizeMatch
      ? {
          width: Number(sizeMatch[1]),
          height: Number(sizeMatch[2]),
          unit: "pt"
        }
      : null
  };
};

const getPdfMetadata = async (pdfPath) => {
  const pdfInfoAvailable = await pdfInfoAvailablePromise;
  if (pdfInfoAvailable) {
    try {
      const { stdout } = await execFileAsync("pdfinfo", ["-box", pdfPath], { maxBuffer: 1024 * 1024 });
      const parsed = parsePdfInfoOutput(stdout);
      if (parsed.pageCount) {
        return parsed;
      }
    } catch {
      // Fall back to pdf-parse below.
    }
  }

  const data = await fs.promises.readFile(pdfPath);
  const parsed = await pdfParse(data);
  return {
    pageCount: parsed.numpages,
    dimensions: null
  };
};

const getRenderSettings = (quality) => {
  if (quality === "low") {
    return {
      jpegQuality: 70,
      dpi: 72
    };
  }

  return {
    jpegQuality: 80,
    dpi: 180
  };
};

const renderPdfPage = async ({ pdfPath, docId, pageNumber, quality, signal }) => {
  const { jpegQuality, dpi } = getRenderSettings(quality);
  const qualityDir = cacheManager.getCacheDir(docId, quality);
  ensureDirectory(qualityDir);

  const outputPrefix = path.join(qualityDir, "page");
  const renderArgs = [
    "-jpeg",
    "-jpegopt",
    `quality=${jpegQuality}`,
    "-r",
    String(dpi),
    "-f",
    String(pageNumber),
    "-l",
    String(pageNumber),
    pdfPath,
    outputPrefix
  ];

  const startedAt = Date.now();
  const procPromise = new Promise((resolve, reject) => {
    const proc = spawn("pdftoppm", renderArgs, { stdio: "ignore", signal });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`pdftoppm failed with code ${code}`));
    });
  });

  await procPromise;
  const imagePath = resolvePageImagePath(qualityDir, pageNumber);

  if (!imagePath) {
    throw new Error(`Rendered page ${pageNumber} was not found on disk`);
  }

  const stat = await fs.promises.stat(imagePath);
  const elapsedMs = Date.now() - startedAt;

  return {
    imagePath,
    sizeBytes: stat.size,
    elapsedMs
  };
};

const logBackendMetrics = (message) => {
  const stats = cacheManager.getStats();
  const timings = cacheManager.getTimingSummary();
  const memory = process.memoryUsage();
  const rssMb = Math.round(memory.rss / 1024 / 1024);
  const heapMb = Math.round(memory.heapUsed / 1024 / 1024);
  const hitRatio = stats.hits + stats.misses > 0 ? (stats.hits / (stats.hits + stats.misses)).toFixed(2) : "1.00";
  const renderRatio = Number(stats.renderPerPageRatio || 0).toFixed(2);

  console.log(
    `[backend] ${message} | queue=${renderQueue.length} active=${activeRenderJobs} cacheEntries=${stats.entries} uniquePages=${stats.uniquePages} renderPerPageRatio=${renderRatio} p50Low=${timings.low.p50}ms p95Low=${timings.low.p95}ms p50High=${timings.high.p50}ms p95High=${timings.high.p95}ms evictions(entry=${stats.evictions.entries},bytes=${stats.evictions.bytes}) cacheBytes=${Math.round(stats.bytes / 1024 / 1024)}MB hitRatio=${hitRatio} rss=${rssMb}MB heap=${heapMb}MB`
  );
};

const sortQueue = () => {
  renderQueue.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return a.enqueuedAt - b.enqueuedAt;
  });
};

const trimQueueForPressure = () => {
  if (renderQueue.length <= MAX_QUEUE_LENGTH) {
    return;
  }

  sortQueue();
  while (renderQueue.length > MAX_QUEUE_LENGTH) {
    const dropped = renderQueue.pop();
    if (!dropped) {
      break;
    }

    dropped.reject(new DOMException("Request cancelled due to queue pressure", "AbortError"));
    pendingRenderPromises.delete(dropped.key);
    console.log(`[backend] dropped queued render doc=${dropped.docId} page=${dropped.pageNumber} quality=${dropped.quality} priority=${dropped.priority}`);
  }
};

const cancelQueuedJob = (job) => {
  const index = renderQueue.findIndex((item) => item.key === job.key);
  if (index >= 0) {
    const [removed] = renderQueue.splice(index, 1);
    if (removed) {
      removed.reject(new DOMException("Request cancelled", "AbortError"));
    }
    pendingRenderPromises.delete(job.key);
    console.log(`[backend] cancelled queued render doc=${job.docId} page=${job.pageNumber} quality=${job.quality}`);
  }
};

const pumpRenderQueue = () => {
  sortQueue();
  while (activeRenderJobs < MAX_ACTIVE_RENDER_JOBS && renderQueue.length > 0) {
    const job = renderQueue.shift();
    if (!job) {
      continue;
    }

    if (job.signal?.aborted) {
      pendingRenderPromises.delete(job.key);
      job.reject(new DOMException("Request cancelled", "AbortError"));
      continue;
    }

    activeRenderJobs += 1;

    (async () => {
      try {
        const cached = cacheManager.getCachedEntry(job.docId, job.pageNumber, job.quality);
        if (cached) {
          logBackendMetrics(`cache-hit doc=${job.docId} page=${job.pageNumber} quality=${job.quality}`);
          job.resolve(cached.filePath);
          return;
        }

        cacheManager.recordCacheMiss();
        const rendered = await renderPdfPage(job);
        cacheManager.recordRender(job.docId, job.pageNumber, job.quality, rendered.imagePath, rendered.sizeBytes);
        cacheManager.observeRenderTime({
          docId: job.docId,
          pageNumber: job.pageNumber,
          quality: job.quality,
          elapsedMs: rendered.elapsedMs
        });
        await cacheManager.evictIfNeeded({ activeDocId: job.docId });
        const stats = cacheManager.getStats();
        const hitRatio = stats.hits + stats.misses > 0 ? (stats.hits / (stats.hits + stats.misses)).toFixed(2) : "1.00";
        console.log(
          `[backend] render doc=${job.docId} page=${job.pageNumber} quality=${job.quality} time=${rendered.elapsedMs}ms hitRatio=${hitRatio}`
        );
        job.resolve(rendered.imagePath);
      } catch (error) {
        job.reject(error);
      } finally {
        activeRenderJobs -= 1;
        pendingRenderPromises.delete(job.key);
        logBackendMetrics(`settled doc=${job.docId} page=${job.pageNumber} quality=${job.quality}`);
        pumpRenderQueue();
      }
    })();
  }
};

const scheduleRender = ({ docId, pageNumber, quality, pdfPath, priority = PRIORITY.buffer, signal = null }) => {
  const key = cacheManager.getEntryKey(docId, pageNumber, quality);
  const existing = pendingRenderPromises.get(key);
  if (existing) {
    return existing;
  }

  if (signal?.aborted) {
    return Promise.reject(new DOMException("Request cancelled", "AbortError"));
  }

  const promise = new Promise((resolve, reject) => {
    const job = {
      key,
      docId,
      pageNumber,
      quality,
      pdfPath,
      resolve,
      reject,
      signal,
      priority,
      enqueuedAt: Date.now()
    };

    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          cancelQueuedJob(job);
          reject(new DOMException("Request cancelled", "AbortError"));
        },
        { once: true }
      );
    }

    renderQueue.push(job);
    trimQueueForPressure();
    pumpRenderQueue();
  });

  const trackedPromise = promise.finally(() => {
    pendingRenderPromises.delete(key);
  });

  pendingRenderPromises.set(key, trackedPromise);
  return trackedPromise;
};

const warmFirstPage = (docId) => {
  const documentRecord = cacheManager.getDocument(docId);
  if (!documentRecord) {
    return;
  }

  void scheduleRender({
    docId,
    pageNumber: 1,
    quality: "low",
    pdfPath: documentRecord.filePath,
    priority: PRIORITY.current
  }).then(() =>
    scheduleRender({
      docId,
      pageNumber: 1,
      quality: "high",
      pdfPath: documentRecord.filePath,
      priority: PRIORITY.current
    })
  ).catch(() => undefined);
};

const getDocumentOrNull = (docId) => cacheManager.getDocument(docId);

const getPageImageOrRender = async ({ docId, pageNumber, quality, priority, signal }) => {
  const documentRecord = getDocumentOrNull(docId);
  if (!documentRecord) {
    return { error: { status: 404, message: "Document not found" } };
  }

  if (!Number.isFinite(pageNumber) || pageNumber < 1 || pageNumber > documentRecord.pageCount) {
    return { error: { status: 400, message: "Invalid page number" } };
  }

  const cached = cacheManager.getCachedEntry(docId, pageNumber, quality);
  if (cached) {
    return { imagePath: cached.filePath, documentRecord };
  }

  const imagePath = await scheduleRender({
    docId,
    pageNumber,
    quality,
    pdfPath: documentRecord.filePath,
    priority: normalizePriority(priority, pageNumber, quality),
    signal
  });

  return { imagePath, documentRecord };
};

const shutdown = async () => {
  if (serverInstance) {
    await new Promise((resolve) => serverInstance.close(resolve));
  }

  try {
    await cacheManager.persistNow();
  } catch {
    // Ignore shutdown persistence failures.
  }
};

const findPidOnPort = async (port) => {
  try {
    const { stdout } = await execFileAsync("cmd", ["/c", `netstat -ano | findstr :${port}`], { maxBuffer: 1024 * 1024 });
    const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isFinite(pid)) {
        return pid;
      }
    }
  } catch {
    // If netstat fails, just report no PID.
  }

  return null;
};

const ensurePortAvailable = async (port) => {
  const server = net.createServer();
  return new Promise((resolve) => {
    server.once("error", async (error) => {
      server.close();
      if (error.code === "EADDRINUSE") {
        const pid = await findPidOnPort(port);
        if (AUTO_KILL_PREVIOUS && pid) {
          try {
            await execFileAsync("taskkill", ["/PID", String(pid), "/F"]);
            resolve(true);
            return;
          } catch {
            resolve(false);
            return;
          }
        }
      }

      resolve(false);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "0.0.0.0");
  });
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/upload", upload.single("pdf"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No PDF provided" });
  }

  try {
    const popplerAvailable = await popplerAvailablePromise;
    if (!popplerAvailable) {
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(503).json({ error: "Server image pipeline unavailable. Install Poppler (pdftoppm)." });
    }

    const metadata = await getPdfMetadata(req.file.path);
    if (!metadata.pageCount || metadata.pageCount < 1) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Corrupted or unreadable PDF" });
    }

    if (metadata.pageCount > MAX_UPLOAD_PAGES) {
      fs.unlinkSync(req.file.path);
      return res.status(422).json({ error: `PDF exceeds ${MAX_UPLOAD_PAGES} pages` });
    }

    const id = randomUUID();
    const pagesPath = `/page/${id}`;
    const now = Date.now();

    cacheManager.registerDocument({
      docId: id,
      filePath: req.file.path,
      originalName: req.file.originalname,
      pageCount: metadata.pageCount,
      dimensions: metadata.dimensions,
      size: req.file.size,
      renderMode: "server-images",
      pagesPath,
      status: "ready_partial",
      pagesRendered: 0,
      pagesRenderedLow: 0,
      pagesRenderedHigh: 0,
      lastAccessTime: now,
      createdAt: now,
      error: null
    });

    ensureDirectory(path.join(pageCacheDir, id));
    warmFirstPage(id);

    return res.status(202).json({
      id,
      pageCount: metadata.pageCount,
      dimensions: metadata.dimensions,
      fileName: req.file.originalname,
      size: req.file.size,
      renderMode: "server-images",
      pagesPath,
      popplerAvailable,
      status: "ready_partial"
    });
  } catch (error) {
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    return res.status(400).json({ error: error.message || "Corrupted or unreadable PDF" });
  }
});

app.get("/sample", (_req, res) => {
  const preferredSamplePath = path.resolve("..", "assets", "pages", "example-20.pdf");
  const fallbackSamplePath = path.resolve("..", "assets", "pages", "smoke-test.pdf");
  const samplePath = fs.existsSync(preferredSamplePath) ? preferredSamplePath : fallbackSamplePath;

  if (!fs.existsSync(samplePath)) {
    return res.status(404).json({ error: "Sample PDF not found" });
  }

  return res.sendFile(samplePath);
});

app.get("/pdf/:id", (req, res) => {
  const item = getDocumentOrNull(req.params.id);
  if (!item) {
    return res.status(404).json({ error: "PDF not found" });
  }

  return res.sendFile(path.resolve(item.filePath));
});

app.get("/document/:id", (req, res) => {
  const item = getDocumentOrNull(req.params.id);
  if (!item) {
    return res.status(404).json({ error: "Document not found" });
  }

  return res.json({
    id: req.params.id,
    pageCount: item.pageCount,
    status: item.status,
    renderMode: item.renderMode,
    pagesPath: item.pagesPath,
    dimensions: item.dimensions,
    pagesRendered: item.pagesRendered,
    pagesRenderedLow: item.pagesRenderedLow,
    pagesRenderedHigh: item.pagesRenderedHigh,
    lastAccessTime: item.lastAccessTime,
    error: item.error
  });
});

app.get("/page/:id/:pageNumber", async (req, res) => {
  const documentRecord = getDocumentOrNull(req.params.id);
  if (!documentRecord) {
    return res.status(404).json({ error: "Document not found" });
  }

  const pageNumber = Number(req.params.pageNumber);
  if (!Number.isFinite(pageNumber) || pageNumber < 1 || pageNumber > documentRecord.pageCount) {
    return res.status(400).json({ error: "Invalid page number" });
  }

  const quality = req.query.quality === "low" ? "low" : "high";
  const priority = normalizePriority(req.query.priority, Math.floor(pageNumber), quality);
  const abortController = new AbortController();

  const abortOnClose = () => abortController.abort();
  req.on("close", abortOnClose);

  try {
    const result = await getPageImageOrRender({
      docId: req.params.id,
      pageNumber: Math.floor(pageNumber),
      quality,
      priority,
      signal: abortController.signal
    });

    if (result.error) {
      return res.status(result.error.status).json({ error: result.error.message });
    }

    cacheManager.touchDocument(req.params.id);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.sendFile(result.imagePath);
  } catch (error) {
    if (error.name === "AbortError") {
      return;
    }
    return res.status(500).json({ error: error.message || "Page rendering failed" });
  } finally {
    req.off("close", abortOnClose);
  }
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({ error: "File too large. Max size is 80MB." });
    }
    return res.status(400).json({ error: err.message || "Upload failed" });
  }

  if (err.message === "Only PDF files are allowed") {
    return res.status(415).json({ error: "Only PDF files are allowed" });
  }

  return res.status(400).json({ error: err.message || "Request failed" });
});

const startServer = async () => {
  const available = await ensurePortAvailable(PORT);
  if (!available) {
    console.error(`Port ${PORT} is already in use. Set AUTO_KILL_PREVIOUS=1 to terminate the existing process automatically.`);
    process.exit(1);
  }

  serverInstance = app.listen(PORT, () => {
    console.log(`Backend listening on http://localhost:${PORT}`);
    if (AUTO_KILL_PREVIOUS) {
      console.log("AUTO_KILL_PREVIOUS is enabled for future port conflicts.");
    }
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await shutdown();
      process.exit(0);
    });
  }
};

startServer().catch((error) => {
  console.error(error);
  process.exit(1);
});
