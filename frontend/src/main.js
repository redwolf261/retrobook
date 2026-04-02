import "./styles.css";
import { PageFlip } from "page-flip";

const hamburgerBtn = document.getElementById("hamburger-btn");
const pdfModal = document.getElementById("pdf-modal");
const modalCloseBtn = document.getElementById("modal-close-btn");
const uploadForm = document.getElementById("upload-form");
const pdfInput = document.getElementById("pdf-input");
const sampleBtn = document.getElementById("sample-btn");
const statusEl = document.getElementById("status");
const loaderEl = document.getElementById("loader");
const bookWrapper = document.getElementById("book-wrapper");
const bookEl = document.getElementById("book");
const prevBtn = document.getElementById("prev-btn");
const nextBtn = document.getElementById("next-btn");
const pageIndicator = document.getElementById("page-indicator");
const zoomInBtn = document.getElementById("zoom-in-btn");
const zoomOutBtn = document.getElementById("zoom-out-btn");
const fitWidthBtn = document.getElementById("fit-width-btn");
const bookmarkBtn = document.getElementById("bookmark-btn");
const openBookmarkBtn = document.getElementById("open-bookmark-btn");
const pageJumpInput = document.getElementById("page-jump-input");
const pageJumpBtn = document.getElementById("page-jump-btn");
const immersionBtn = document.getElementById("immersion-btn");

const state = {
  fileId: null,
  pageCount: 0,
  renderMode: "server-images",
  pagesPath: null,
  processingStatus: "idle",
  pageFlip: null,
  pageNodes: [],
  imageUrls: new Map(),
  renderPromises: new Map(),
  isMobile: window.matchMedia("(max-width: 900px)").matches,
  quality: 0.82,
  zoom: 1,
  maxZoom: 1.45,
  minZoom: 0.78,
  fitToWidth: false,
  modalOpen: false,
  immersionMode: false,
  bookmarkPage: null,
  audioCtx: null,
  lastPage: 1,
  renderQueue: [],
  activeRenders: 0,
  requestControllers: new Map(),
  firstPageRequestedAt: 0,
  firstPageLogged: false
};

const NETWORK_TIMEOUT_MS = 45000;
const MAX_CONCURRENT_RENDERS = 5;
const MEMORY_WINDOW_RADIUS = 4;

const updateStatus = (message) => {
  statusEl.textContent = message;
};

const showLoader = (visible, message = "") => {
  loaderEl.classList.toggle("hidden", !visible);
  if (visible && message) {
    loaderEl.textContent = message;
  }
};

const updatePageIndicator = (currentPage) => {
  pageIndicator.textContent = `Page ${currentPage} / ${state.pageCount}`;
};

const getCurrentPage = () => {
  if (!state.pageFlip) {
    return 1;
  }
  return Number(state.pageFlip.getCurrentPageIndex() || 0) + 1;
};

const setZoom = (nextZoom) => {
  state.zoom = Math.min(state.maxZoom, Math.max(state.minZoom, nextZoom));
  bookEl.style.transform = `scale(${state.zoom})`;
};

const openModal = () => {
  pdfModal.classList.remove("hidden");
  state.modalOpen = true;
  pdfInput.focus();
};

const closeModal = () => {
  pdfModal.classList.add("hidden");
  state.modalOpen = false;
};

const toggleImmersion = () => {
  state.immersionMode = !state.immersionMode;
  document.body.classList.toggle("immersion-active", state.immersionMode);
  immersionBtn.textContent = state.immersionMode ? "⛶ Exit" : "⛶ Fullscreen";
};

const toggleFitToWidth = () => {
  state.fitToWidth = !state.fitToWidth;
  bookWrapper.classList.toggle("fit-width-active", state.fitToWidth);
  fitWidthBtn.textContent = state.fitToWidth ? "📖 Book View" : "📄 Fit Width";
};

const playFlipSound = () => {
  try {
    if (!state.audioCtx) {
      state.audioCtx = new window.AudioContext();
    }

    const now = state.audioCtx.currentTime;
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();

    osc.type = "triangle";
    osc.frequency.setValueAtTime(700, now);
    osc.frequency.exponentialRampToValueAtTime(220, now + 0.07);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.018, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.11);

    osc.connect(gain);
    gain.connect(state.audioCtx.destination);

    osc.start(now);
    osc.stop(now + 0.12);
  } catch {
    // Ignore sound errors where autoplay/audio context is blocked.
  }
};

const readBookmarkFromStorage = () => {
  const raw = window.localStorage.getItem("pdfFlipbookBookmark");
  const value = Number(raw || "0");
  if (!Number.isFinite(value) || value < 1) {
    state.bookmarkPage = null;
    return;
  }
  state.bookmarkPage = Math.floor(value);
};

const saveBookmarkToStorage = (page) => {
  window.localStorage.setItem("pdfFlipbookBookmark", String(page));
  state.bookmarkPage = page;
};

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: options.signal || controller.signal
    });
  } finally {
    window.clearTimeout(timeoutId);
  }
};

const buildPageRequestUrl = (pageNumber, quality, priority) => {
  const url = new URL(`${state.pagesPath}/${pageNumber}`, window.location.origin);
  url.searchParams.set("quality", quality);
  if (priority) {
    url.searchParams.set("priority", priority);
  }
  return url.toString();
};

const clearPreviousBook = () => {
  if (state.pageFlip) {
    state.pageFlip.destroy();
    state.pageFlip = null;
  }

  for (const controller of state.requestControllers.values()) {
    controller.abort();
  }

  for (const job of state.renderQueue) {
    job.reject(new DOMException("Request cancelled", "AbortError"));
  }

  for (const url of state.imageUrls.values()) {
    URL.revokeObjectURL(url);
  }

  state.imageUrls.clear();
  state.renderPromises.clear();
  state.renderQueue = [];
  state.activeRenders = 0;
  state.requestControllers.clear();
  state.firstPageRequestedAt = 0;
  state.firstPageLogged = false;
  state.pageNodes = [];
  bookEl.innerHTML = "";
  setZoom(1);
  updatePageIndicator(0);
};

const makePageNode = (pageNumber) => {
  const page = document.createElement("div");
  page.className = "page";

  const inner = document.createElement("div");
  inner.className = "page-inner loading";
  inner.dataset.pageNumber = String(pageNumber);
  inner.textContent = `Loading page ${pageNumber}...`;

  page.appendChild(inner);
  return page;
};

const setPageImage = (pageNumber, objectUrl) => {
  const pageNode = state.pageNodes[pageNumber - 1];
  if (!pageNode) {
    return;
  }

  const inner = pageNode.querySelector(".page-inner");
  if (!inner) {
    return;
  }

  const img = document.createElement("img");
  img.loading = "lazy";
  img.alt = `Page ${pageNumber}`;
  img.src = objectUrl;

  inner.classList.remove("loading");
  inner.textContent = "";
  inner.appendChild(img);

  if (pageNumber === 1 && !state.firstPageLogged) {
    state.firstPageLogged = true;
    if (state.firstPageRequestedAt > 0) {
      const ttfi = Math.round(performance.now() - state.firstPageRequestedAt);
      console.log(`[frontend] TTFI=${ttfi}ms`);
    }
  }
};

const cancelStalePageRequests = (currentPage, keepRadius = MEMORY_WINDOW_RADIUS + 1) => {
  const retainedJobs = [];

  for (const job of state.renderQueue) {
    if (Math.abs(job.pageNumber - currentPage) > keepRadius) {
      job.controller.abort();
      job.reject(new DOMException("Request cancelled", "AbortError"));
      state.renderPromises.delete(job.pageNumber);
      state.requestControllers.delete(job.pageNumber);
      console.log(`[frontend] dropped queued request page=${job.pageNumber}`);
      continue;
    }

    retainedJobs.push(job);
  }

  state.renderQueue = retainedJobs;

  for (const [pageNumber, controller] of state.requestControllers.entries()) {
    if (Math.abs(pageNumber - currentPage) > keepRadius) {
      controller.abort();
      state.requestControllers.delete(pageNumber);
      console.log(`[frontend] cancelled in-flight request page=${pageNumber}`);
    }
  }
};

const pumpRenderQueue = () => {
  while (state.activeRenders < MAX_CONCURRENT_RENDERS && state.renderQueue.length > 0) {
    const job = state.renderQueue.shift();
    if (!job) {
      continue;
    }

    if (job.controller.signal.aborted) {
      state.renderPromises.delete(job.pageNumber);
      state.requestControllers.delete(job.pageNumber);
      job.reject(new DOMException("Request cancelled", "AbortError"));
      continue;
    }

    state.activeRenders += 1;
    job.startedAt = performance.now();
    state.requestControllers.set(job.pageNumber, job.controller);

    (async () => {
      try {
        let imageBlob;

        if (state.renderMode === "server-images" && state.pagesPath) {
          const lowResp = await fetchWithTimeout(buildPageRequestUrl(job.pageNumber, "low", job.priority), {
            signal: job.controller.signal
          });
          if (lowResp.ok) {
            const lowBlob = await lowResp.blob();
            const lowUrl = URL.createObjectURL(lowBlob);
            state.imageUrls.set(job.pageNumber, lowUrl);
            setPageImage(job.pageNumber, lowUrl);
          }

          const highResp = await fetchWithTimeout(buildPageRequestUrl(job.pageNumber, "high", job.priority), {
            signal: job.controller.signal
          });
          if (!highResp.ok) {
            throw new Error(`Page image ${job.pageNumber} failed to load`);
          }
          imageBlob = await highResp.blob();
        } else {
          throw new Error("Server image mode is required for large PDFs");
        }

        if (!imageBlob) {
          throw new Error(`Image conversion failed for page ${job.pageNumber}`);
        }

        const url = URL.createObjectURL(imageBlob);
        const prev = state.imageUrls.get(job.pageNumber);
        if (prev) {
          URL.revokeObjectURL(prev);
        }
        state.imageUrls.set(job.pageNumber, url);
        setPageImage(job.pageNumber, url);
        console.log(`[frontend] request latency page=${job.pageNumber} latency=${Math.round(performance.now() - job.startedAt)}ms`);
        job.resolve(url);
      } catch (error) {
        if (error.name === "AbortError") {
          console.log(`[frontend] request aborted page=${job.pageNumber}`);
        }
        job.reject(error);
      } finally {
        state.activeRenders -= 1;
        state.renderPromises.delete(job.pageNumber);
        state.requestControllers.delete(job.pageNumber);
        pumpRenderQueue();
      }
    })();
  }
};

const renderPageToImage = async (pageNumber, { priority = "buffer" } = {}) => {
  if (state.imageUrls.has(pageNumber)) {
    return state.imageUrls.get(pageNumber);
  }

  if (state.renderPromises.has(pageNumber)) {
    return state.renderPromises.get(pageNumber);
  }

  const task = new Promise((resolve, reject) => {
    const controller = new AbortController();
    state.renderQueue.push({ pageNumber, resolve, reject, startedAt: 0, controller, priority });
    pumpRenderQueue();
  });

  state.renderPromises.set(pageNumber, task);
  return task;
};

const releasePageImage = (pageNumber) => {
  const url = state.imageUrls.get(pageNumber);
  if (!url) {
    return;
  }

  URL.revokeObjectURL(url);
  state.imageUrls.delete(pageNumber);

  const pageNode = state.pageNodes[pageNumber - 1];
  const inner = pageNode?.querySelector(".page-inner");
  if (!inner) {
    return;
  }

  inner.classList.add("loading");
  inner.textContent = `Loading page ${pageNumber}...`;
};

const evictFarPages = (currentPage) => {
  for (const pageNumber of state.imageUrls.keys()) {
    if (Math.abs(pageNumber - currentPage) > MEMORY_WINDOW_RADIUS && !state.renderPromises.has(pageNumber)) {
      releasePageImage(pageNumber);
    }
  }
};

const ensureNearbyPages = async (currentPage, direction = 1) => {
  cancelStalePageRequests(currentPage);

  const forwardOffsets = [];
  const backwardOffsets = [];

  for (let i = 0; i <= MEMORY_WINDOW_RADIUS; i += 1) {
    forwardOffsets.push(i);
    backwardOffsets.push(-i);
  }

  for (let i = -MEMORY_WINDOW_RADIUS; i < 0; i += 1) {
    forwardOffsets.push(i);
  }

  for (let i = 1; i <= MEMORY_WINDOW_RADIUS; i += 1) {
    backwardOffsets.push(i);
  }

  const offsets = direction >= 0 ? forwardOffsets : backwardOffsets;
  const jobs = [];

  for (const offset of offsets) {
    const page = currentPage + offset;
    if (page >= 1 && page <= state.pageCount) {
      const priority = Math.abs(offset) <= 1 ? "current" : Math.abs(offset) <= 2 ? "adjacent" : "buffer";
      jobs.push(renderPageToImage(page, { priority }));
    }
  }

  await Promise.allSettled(jobs);
  evictFarPages(currentPage);
};

const buildBookShell = (pageCount) => {
  const nodes = [];
  for (let i = 1; i <= pageCount; i += 1) {
    const node = makePageNode(i);
    nodes.push(node);
    bookEl.appendChild(node);
  }
  state.pageNodes = nodes;
};

const getPageSize = async () => {
  const ratio = 0.707;

  const wrapperWidth = Math.max(460, bookWrapper.clientWidth);
  const wrapperHeight = Math.max(340, bookWrapper.clientHeight);
  const maxPageHeight = Math.min(wrapperHeight, 820);
  let pageHeight = maxPageHeight;
  let pageWidth = pageHeight * ratio;

  if (pageWidth * 2 > wrapperWidth) {
    pageWidth = Math.floor((wrapperWidth - 20) / 2);
    pageHeight = Math.floor(pageWidth / ratio);
  }

  return {
    width: Math.max(220, Math.floor(pageWidth)),
    height: Math.max(280, Math.floor(pageHeight))
  };
};

const refreshUrlPageParam = (page) => {
  const url = new URL(window.location.href);
  url.searchParams.set("page", String(page));
  window.history.replaceState({}, "", url);
};

const readInitialPageParam = () => {
  const url = new URL(window.location.href);
  const value = Number(url.searchParams.get("page") || "1");
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.floor(value));
};

const initFlipbook = async () => {
  const size = await getPageSize();

  state.pageFlip = new PageFlip(bookEl, {
    width: size.width,
    height: size.height,
    maxShadowOpacity: 0.28,
    showCover: true,
    mobileScrollSupport: false,
    flippingTime: 720,
    drawShadow: true,
    usePortrait: true,
    startZIndex: 2,
    autoSize: true
  });

  state.pageFlip.loadFromHTML(state.pageNodes);

  state.pageFlip.on("flip", async (event) => {
    const index = Number(event.data || 0);
    const currentPage = index + 1;
    const direction = currentPage >= state.lastPage ? 1 : -1;
    updatePageIndicator(currentPage);
    refreshUrlPageParam(currentPage);
    pageJumpInput.value = String(currentPage);
    playFlipSound();
    cancelStalePageRequests(currentPage);
    ensureNearbyPages(currentPage, direction);
    state.lastPage = currentPage;
  });

  const startPage = Math.min(readInitialPageParam(), state.pageCount);
  state.pageFlip.flip(startPage - 1);
  updatePageIndicator(startPage);
  pageJumpInput.value = String(startPage);
  state.lastPage = startPage;
  void ensureNearbyPages(startPage, 1);
  void renderPageToImage(1, { priority: "current" }).catch(() => undefined);
};

const loadUploadedPdf = async (file) => {
  if (file.size > 80 * 1024 * 1024) {
    throw new Error("File too large. Max size is 80MB.");
  }

  state.quality = file.size > 25 * 1024 * 1024 ? 0.72 : 0.82;

  const formData = new FormData();
  formData.append("pdf", file);

  const uploadResp = await fetchWithTimeout("/upload", {
    method: "POST",
    body: formData
  });

  const uploadRaw = await uploadResp.text();
  let uploadJson = {};
  try {
    uploadJson = uploadRaw ? JSON.parse(uploadRaw) : {};
  } catch {
    uploadJson = {};
  }

  if (!uploadResp.ok) {
    const fallback = uploadRaw ? uploadRaw.slice(0, 180) : "Upload failed";
    throw new Error(uploadJson.error || `Upload failed (${uploadResp.status}) ${fallback}`);
  }

  state.fileId = uploadJson.id;
  state.pageCount = uploadJson.pageCount;
  state.renderMode = uploadJson.renderMode || "server-images";
  state.pagesPath = uploadJson.pagesPath || null;
  state.processingStatus = uploadJson.status || "ready_partial";

  if (state.pageCount < 1) {
    throw new Error("PDF has no pages");
  }

  if (state.pageCount > 10000) {
    throw new Error("PDF exceeds 10000 pages");
  }

  if (state.renderMode !== "server-images" || !state.pagesPath) {
    throw new Error("Server did not provide image streaming mode");
  }

  readBookmarkFromStorage();
};

const processSelectedFile = async (file) => {
  clearPreviousBook();
  showLoader(true, "Uploading and analyzing PDF...");
  bookWrapper.classList.add("hidden");

  try {
    await loadUploadedPdf(file);
    const modeLabel = state.renderMode === "server-images" ? "server image cache" : "client PDF rendering";
    updateStatus(`Loaded ${state.pageCount} pages. Preparing first page from ${modeLabel}...`);

    buildBookShell(state.pageCount);
    bookWrapper.classList.remove("hidden");
    state.firstPageRequestedAt = performance.now();
    void renderPageToImage(1).catch(() => undefined);
    await initFlipbook();

    updateStatus("Ready. Click anywhere to flip, or use arrow keys ← →");
  } catch (error) {
    clearPreviousBook();
    updateStatus(error.name === "AbortError" ? "Network timeout while loading PDF" : error.message || "Could not load PDF");
  } finally {
    showLoader(false);
  }
};

// Modal event listeners
hamburgerBtn.addEventListener("click", openModal);
modalCloseBtn.addEventListener("click", closeModal);
pdfModal.querySelector(".modal-overlay").addEventListener("click", closeModal);

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = pdfInput.files?.[0];
  if (!file) {
    updateStatus("Choose a PDF first.");
    return;
  }

  await processSelectedFile(file);
  closeModal();
});

sampleBtn.addEventListener("click", async () => {
  showLoader(true, "Loading bundled sample...");
  try {
    const resp = await fetchWithTimeout("/sample");
    if (!resp.ok) {
      throw new Error("Sample PDF is unavailable");
    }

    const blob = await resp.blob();
    const file = new File([blob], "example.pdf", { type: "application/pdf" });
    await processSelectedFile(file);
  } catch (error) {
    showLoader(false);
    updateStatus(error.name === "AbortError" ? "Network timeout while loading sample" : error.message || "Could not load sample PDF");
  }
});

prevBtn.addEventListener("click", () => {
  state.pageFlip?.flipPrev();
});

nextBtn.addEventListener("click", () => {
  state.pageFlip?.flipNext();
});

window.addEventListener("keydown", (event) => {
  if (!state.pageFlip) {
    return;
  }

  if (event.key === "ArrowLeft") {
    state.pageFlip.flipPrev();
  }

  if (event.key === "ArrowRight") {
    state.pageFlip.flipNext();
  }
});

zoomInBtn.addEventListener("click", () => {
  setZoom(state.zoom + 0.08);
});

zoomOutBtn.addEventListener("click", () => {
  setZoom(state.zoom - 0.08);
});

bookmarkBtn.addEventListener("click", () => {
  if (!state.pageFlip) {
    return;
  }
  const page = getCurrentPage();
  saveBookmarkToStorage(page);
  updateStatus(`Bookmarked page ${page}.`);
});

openBookmarkBtn.addEventListener("click", () => {
  if (!state.pageFlip) {
    updateStatus("Load a PDF first.");
    return;
  }

  if (!state.bookmarkPage) {
    updateStatus("No bookmark saved yet.");
    return;
  }

  const page = Math.min(state.bookmarkPage, state.pageCount);
  state.pageFlip.flip(page - 1);
});

pageJumpBtn.addEventListener("click", () => {
  if (!state.pageFlip) {
    return;
  }

  const target = Number(pageJumpInput.value || "1");
  if (!Number.isFinite(target)) {
    return;
  }

  const page = Math.max(1, Math.min(state.pageCount, Math.floor(target)));
  cancelStalePageRequests(page);
  state.pageFlip.flip(page - 1);
});

pageJumpInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    pageJumpBtn.click();
  }
});

immersionBtn.addEventListener("click", () => {
  toggleImmersion();
});

fitWidthBtn.addEventListener("click", () => {
  toggleFitToWidth();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (state.modalOpen) {
      closeModal();
    } else if (state.immersionMode) {
      toggleImmersion();
    }
  }
});

window.addEventListener("resize", () => {
  state.isMobile = window.matchMedia("(max-width: 900px)").matches;
});
