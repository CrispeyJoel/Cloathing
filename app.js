/* ============================================================
   Closet — storage, trace/cutout, split, outfit canvas
   ============================================================ */

// Surface errors instead of silently doing nothing — makes future bugs
// reportable instead of invisible.
window.addEventListener("error", (e) => {
  alert("Something went wrong: " + (e.message || "unknown error") + "\n(Screenshot this and send it over.)");
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = (e.reason && e.reason.message) ? e.reason.message : String(e.reason);
  alert("Something went wrong: " + msg + "\n(Screenshot this and send it over.)");
});

const CAT_ORDER = { body: 0, bottom: 1, shoes: 1, top: 2, outerwear: 3, accessory: 4 };
const CAT_LABEL = { top: "Top", outerwear: "Outerwear", bottom: "Bottom", shoes: "Shoes", accessory: "Accessory", body: "Body" };

/* ---------------- IndexedDB ---------------- */
let db;
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("closet-db", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains("items")) d.createObjectStore("items", { keyPath: "id" });
      if (!d.objectStoreNames.contains("state")) d.createObjectStore("state", { keyPath: "key" });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}
function idbPut(store, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbGet(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readonly");
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function idbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
function uuid() {
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------- Screen / tab navigation ---------------- */
const screens = {
  closet: document.getElementById("screen-closet"),
  outfit: document.getElementById("screen-outfit"),
  add: document.getElementById("screen-add"),
};
function showScreen(name) {
  if (name !== "add") stopTimerCamera();
  Object.values(screens).forEach(s => s.classList.remove("active"));
  screens[name].classList.add("active");
  document.querySelectorAll(".tab-btn[data-screen]").forEach(b => {
    b.classList.toggle("active", b.dataset.screen === name);
  });
}
document.querySelectorAll(".tab-btn[data-screen]").forEach(btn => {
  btn.addEventListener("click", () => {
    showScreen(btn.dataset.screen);
    if (btn.dataset.screen === "closet") renderClosetGrid();
    if (btn.dataset.screen === "outfit") renderTray();
  });
});
document.getElementById("addTabBtn").addEventListener("click", () => {
  resetAddFlow();
  showScreen("add");
});
document.getElementById("addBack").addEventListener("click", () => {
  resetAddFlow();
  showScreen("closet");
  renderClosetGrid();
});

/* ---------------- Canvas helpers ---------------- */
function trimCanvas(canvas) {
  const ctx = canvas.getContext("2d");
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  const step = 2;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const a = data[(y * width + x) * 4 + 3];
      if (a > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) { minX = 0; minY = 0; maxX = width - 1; maxY = height - 1; }
  minX = Math.max(0, minX - step); minY = Math.max(0, minY - step);
  maxX = Math.min(width - 1, maxX + step); maxY = Math.min(height - 1, maxY + step);
  const w = maxX - minX + 1, h = maxY - minY + 1;
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  out.getContext("2d").drawImage(canvas, minX, minY, w, h, 0, 0, w, h);
  return { canvas: out, offsetX: minX, offsetY: minY, width: w, height: h };
}

function maskCutout(sourceCanvas, points) {
  const w = sourceCanvas.width, h = sourceCanvas.height;
  const out = document.createElement("canvas");
  out.width = w; out.height = h;
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = "source-in";
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.globalCompositeOperation = "source-over";
  return out;
}

function maskHalf(sourceCanvas, maskPoints) {
  const out = document.createElement("canvas");
  out.width = sourceCanvas.width; out.height = sourceCanvas.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(sourceCanvas, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.fillStyle = "#000";
  ctx.beginPath();
  ctx.moveTo(maskPoints[0].x, maskPoints[0].y);
  for (let i = 1; i < maskPoints.length; i++) ctx.lineTo(maskPoints[i].x, maskPoints[i].y);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  return out;
}

function canvasToDataURL(c) { return c.toDataURL("image/png"); }

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/* ---- Magnetic edge snapping (Sobel gradient magnitude, classic image processing) ---- */
function computeEdgeMap(canvas) {
  const w = canvas.width, h = canvas.height;
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  const mag = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = -gray[i - w - 1] + gray[i - w + 1] - 2 * gray[i - 1] + 2 * gray[i + 1] - gray[i + w - 1] + gray[i + w + 1];
      const gy = -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] + gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      mag[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return { mag, w, h };
}
const EDGE_SNAP_RADIUS = 12;
const EDGE_SNAP_THRESHOLD = 45; // minimum gradient strength to count as a real edge
function snapToEdge(p, edgeMap) {
  if (!edgeMap) return p;
  const { mag, w, h } = edgeMap;
  const cx = Math.round(p.x), cy = Math.round(p.y);
  let bestX = cx, bestY = cy, bestVal = -1;
  const r2 = EDGE_SNAP_RADIUS * EDGE_SNAP_RADIUS;
  for (let dy = -EDGE_SNAP_RADIUS; dy <= EDGE_SNAP_RADIUS; dy++) {
    const yy = cy + dy;
    if (yy < 1 || yy >= h - 1) continue;
    for (let dx = -EDGE_SNAP_RADIUS; dx <= EDGE_SNAP_RADIUS; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const xx = cx + dx;
      if (xx < 1 || xx >= w - 1) continue;
      const v = mag[yy * w + xx];
      if (v > bestVal) { bestVal = v; bestX = xx; bestY = yy; }
    }
  }
  if (bestVal >= EDGE_SNAP_THRESHOLD) return { x: bestX, y: bestY, snapped: true };
  return { x: p.x, y: p.y, snapped: false };
}

/* ---- Live-wire path between two trace points (intelligent-scissors style
   shortest path along edge strength — classic Dijkstra, no AI/ML) ---- */
class MinHeap {
  constructor() { this.a = []; }
  push(priority, value) {
    this.a.push([priority, value]);
    let i = this.a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.a[p][0] <= this.a[i][0]) break;
      [this.a[p], this.a[i]] = [this.a[i], this.a[p]];
      i = p;
    }
  }
  pop() {
    if (this.a.length === 0) return null;
    const top = this.a[0];
    const last = this.a.pop();
    if (this.a.length > 0) {
      this.a[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let smallest = i;
        if (l < this.a.length && this.a[l][0] < this.a[smallest][0]) smallest = l;
        if (r < this.a.length && this.a[r][0] < this.a[smallest][0]) smallest = r;
        if (smallest === i) break;
        [this.a[smallest], this.a[i]] = [this.a[i], this.a[smallest]];
        i = smallest;
      }
    }
    return top; // [priority, value]
  }
  get size() { return this.a.length; }
}
const LIVEWIRE_MAX_SPAN = 260; // px; beyond this, fall back to a straight line
const LIVEWIRE_PAD = 26;
const LIVEWIRE_NEIGHBORS = [[1,0,1],[-1,0,1],[0,1,1],[0,-1,1],[1,1,Math.SQRT2],[1,-1,Math.SQRT2],[-1,1,Math.SQRT2],[-1,-1,Math.SQRT2]];
function liveWirePath(edgeMap, p0, p1) {
  if (!edgeMap) return [p0, p1];
  const span = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  if (span < 2 || span > LIVEWIRE_MAX_SPAN) return [p0, p1];

  const { mag, w, h } = edgeMap;
  const minX = Math.max(0, Math.floor(Math.min(p0.x, p1.x)) - LIVEWIRE_PAD);
  const maxX = Math.min(w - 1, Math.ceil(Math.max(p0.x, p1.x)) + LIVEWIRE_PAD);
  const minY = Math.max(0, Math.floor(Math.min(p0.y, p1.y)) - LIVEWIRE_PAD);
  const maxY = Math.min(h - 1, Math.ceil(Math.max(p0.y, p1.y)) + LIVEWIRE_PAD);
  const bw = maxX - minX + 1, bh = maxY - minY + 1;
  if (bw * bh > 90000) return [p0, p1]; // safety cap for very long/odd spans

  let maxMag = 1;
  for (let y = minY; y <= maxY; y++) {
    const rowBase = y * w;
    for (let x = minX; x <= maxX; x++) {
      const v = mag[rowBase + x];
      if (v > maxMag) maxMag = v;
    }
  }

  const N = bw * bh;
  const distArr = new Float32Array(N).fill(Infinity);
  const visited = new Uint8Array(N);
  const prev = new Int32Array(N).fill(-1);
  const sx = Math.round(p0.x) - minX, sy = Math.round(p0.y) - minY;
  const gx0 = Math.round(p1.x) - minX, gy0 = Math.round(p1.y) - minY;
  const start = sy * bw + sx, goal = gy0 * bw + gx0;
  if (start < 0 || start >= N || goal < 0 || goal >= N) return [p0, p1];
  distArr[start] = 0;

  const heap = new MinHeap();
  heap.push(0, start);
  while (heap.size) {
    const [d, u] = heap.pop();
    if (visited[u]) continue;
    visited[u] = 1;
    if (u === goal) break;
    const ux = u % bw, uy = (u / bw) | 0;
    for (let k = 0; k < 8; k++) {
      const [ddx, ddy, base] = LIVEWIRE_NEIGHBORS[k];
      const vx = ux + ddx, vy = uy + ddy;
      if (vx < 0 || vx >= bw || vy < 0 || vy >= bh) continue;
      const v = vy * bw + vx;
      if (visited[v]) continue;
      const edgeStrength = mag[(vy + minY) * w + (vx + minX)];
      const cost = base * (1 + ((maxMag - edgeStrength) / maxMag) * 9); // cheap to travel along strong edges
      const nd = d + cost;
      if (nd < distArr[v]) { distArr[v] = nd; prev[v] = u; heap.push(nd, v); }
    }
  }
  if (distArr[goal] === Infinity) return [p0, p1];

  const path = [];
  let cur = goal, guard = 0;
  while (cur !== -1 && guard < N + 5) {
    path.push({ x: (cur % bw) + minX, y: ((cur / bw) | 0) + minY });
    cur = prev[cur];
    guard++;
  }
  path.reverse();
  return path.length >= 2 ? path : [p0, p1];
}

/* ---- Zoom/pan controller for a canvas inside a clipping wrap ---- */
function makeZoomPan(canvas, wrap) {
  const state = { fit: 1, zoom: 1, tx: 0, ty: 0 };
  function computeFit() {
    const ww = wrap.clientWidth, wh = wrap.clientHeight;
    state.fit = Math.min(ww / canvas.width, wh / canvas.height, 1) || 1;
  }
  function clamp() {
    state.zoom = Math.min(5, Math.max(1, state.zoom));
    const dispW = canvas.width * state.fit * state.zoom;
    const dispH = canvas.height * state.fit * state.zoom;
    const ww = wrap.clientWidth, wh = wrap.clientHeight;
    if (dispW <= ww) state.tx = (ww - dispW) / 2;
    else state.tx = Math.min(0, Math.max(ww - dispW, state.tx));
    if (dispH <= wh) state.ty = (wh - dispH) / 2;
    else state.ty = Math.min(0, Math.max(wh - dispH, state.ty));
  }
  function apply() {
    canvas.style.width = canvas.width + "px";
    canvas.style.height = canvas.height + "px";
    canvas.style.transformOrigin = "0 0";
    canvas.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.fit * state.zoom})`;
  }
  function reset() {
    computeFit();
    state.zoom = 1;
    clamp();
    apply();
  }
  function setZoom(z) {
    state.zoom = z;
    clamp();
    apply();
  }
  function zoomAt(z, anchorX, anchorY) {
    // Change zoom while keeping the content under (anchorX, anchorY) — in
    // wrap-local pixels — visually stationary, like a real pinch gesture.
    const oldScale = state.fit * state.zoom;
    const newZoom = Math.min(5, Math.max(1, z));
    const newScale = state.fit * newZoom;
    const contentX = (anchorX - state.tx) / oldScale;
    const contentY = (anchorY - state.ty) / oldScale;
    state.zoom = newZoom;
    state.tx = anchorX - contentX * newScale;
    state.ty = anchorY - contentY * newScale;
    clamp();
    apply();
  }
  function pan(dx, dy) {
    state.tx += dx;
    state.ty += dy;
    clamp();
    apply();
  }
  return { state, reset, setZoom, zoomAt, pan, clamp, apply };
}

/* ---- Tap / pan / pinch-zoom interaction for a trace-style canvas ---- */
function attachCanvasInteraction(canvas, wrap, zp, onTap) {
  const pointers = new Map();
  let mode = null; // "maybe" | "pan" | "pinch"
  let startDist = 0, startZoom = 1;
  let downInfo = null, panStartTxTy = null;
  let hadPinch = false; // true once this gesture has involved 2 fingers
  let pinchStartMidLocal = null, pinchStartTx = 0, pinchStartTy = 0;

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  canvas.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      downInfo = { x: e.clientX, y: e.clientY, moved: false };
      panStartTxTy = { tx: zp.state.tx, ty: zp.state.ty };
      mode = "maybe";
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      startDist = dist(a, b);
      startZoom = zp.state.zoom;
      mode = "pinch";
      hadPinch = true;
      const wrapRect = wrap.getBoundingClientRect();
      pinchStartMidLocal = { x: (a.x + b.x) / 2 - wrapRect.left, y: (a.y + b.y) / 2 - wrapRect.top };
      pinchStartTx = zp.state.tx;
      pinchStartTy = zp.state.ty;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === "pinch" && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = dist(a, b);
      if (startDist > 0) {
        const newZoom = Math.min(5, Math.max(1, startZoom * (d / startDist)));
        const wrapRect = wrap.getBoundingClientRect();
        const midX = (a.x + b.x) / 2 - wrapRect.left;
        const midY = (a.y + b.y) / 2 - wrapRect.top;
        // Keep the content that was under the fingers at pinch-start following
        // the fingers as they move, in addition to scaling — pan + zoom together.
        const oldScale = zp.state.fit * startZoom;
        const contentX = (pinchStartMidLocal.x - pinchStartTx) / oldScale;
        const contentY = (pinchStartMidLocal.y - pinchStartTy) / oldScale;
        const newScale = zp.state.fit * newZoom;
        zp.state.zoom = newZoom;
        zp.state.tx = midX - contentX * newScale;
        zp.state.ty = midY - contentY * newScale;
        zp.clamp();
        zp.apply();
      }
    } else if (pointers.size === 1 && downInfo) {
      const dx = e.clientX - downInfo.x, dy = e.clientY - downInfo.y;
      if (mode === "pan" || Math.hypot(dx, dy) > 6) {
        downInfo.moved = true;
        mode = "pan";
        zp.state.tx = panStartTxTy.tx + dx;
        zp.state.ty = panStartTxTy.ty + dy;
        zp.clamp(); zp.apply();
      }
    }
  });
  function finish(e) {
    const wasTap = pointers.size === 1 && mode === "maybe" && downInfo && !downInfo.moved && !hadPinch;
    if (wasTap) {
      const rect = canvas.getBoundingClientRect();
      const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
      onTap({ x: (downInfo.x - rect.left) * sx, y: (downInfo.y - rect.top) * sy });
    }
    pointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch (err) {}
    if (pointers.size === 0) { mode = null; downInfo = null; panStartTxTy = null; hadPinch = false; }
    else if (pointers.size === 1) { mode = "maybe"; }
  }
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
}

/* ============================================================
   ADD FLOW STATE
   ============================================================ */
let addState = {};

function resetAddFlow() {
  stopTimerCamera();
  addState = {
    photoImg: null,
    baseCanvas: null,     // photo drawn at working resolution
    tracePoints: [],
    tracePathSegments: [],
    fullCutoutCanvas: null, // masked cutout at working resolution (untrimmed)
    category: null,
    openFront: false,
    splitPoints: [],
    finalItems: [],       // one item (normal) or two items (split pair)
    editMode: false,      // true when re-cropping an existing closet item
    editPairId: null, editItemId: null, editLeftId: null, editRightId: null,
    editName: null, editCategory: null,
    snapEnabled: true,    // magnetic edge snap + live-wire, toggleable while tracing
    stepStack: [],         // for the per-step Back/Retake button
  };
  document.querySelectorAll(".add-step").forEach(s => s.classList.remove("active"));
  document.getElementById("addStepCapture").classList.add("active");
  document.getElementById("addStepLabel").textContent = "Photograph item";
  document.getElementById("addStepBack").style.visibility = "hidden";
  document.getElementById("captureInput").value = "";
  document.getElementById("traceConfirm").disabled = true;
  document.getElementById("itemNameInput").value = "";
  document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("selected"));
  document.getElementById("categoryContinue").disabled = true;
  document.getElementById("openFrontRow").hidden = true;
  document.getElementById("openFrontToggle").checked = false;
  setSnapToggleUI(true);
}

function setSnapToggleUI(on) {
  const btn = document.getElementById("snapToggleBtn");
  btn.textContent = on ? "Snap to edge: On" : "Snap to edge: Off";
  btn.classList.toggle("active", on);
}
document.getElementById("snapToggleBtn").addEventListener("click", () => {
  addState.snapEnabled = !addState.snapEnabled;
  setSnapToggleUI(addState.snapEnabled);
});

const ADD_STEP_LABELS = {
  addStepCapture: "Photograph item",
  addStepTimerCam: "Self-timer photo",
  addStepTrace: "Trace the item",
  addStepCategory: "Choose a category",
  addStepSplit: "Mark the opening",
  addStepSave: "Name & save",
};
function goAddStep(id, label, opts = {}) {
  const { fromBack = false } = opts;
  if (!fromBack) {
    const current = document.querySelector(".add-step.active");
    if (current && current.id !== id) {
      addState.stepStack = addState.stepStack || [];
      addState.stepStack.push(current.id);
    }
  }
  document.querySelectorAll(".add-step").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.getElementById("addStepLabel").textContent = label;
  const backBtn = document.getElementById("addStepBack");
  const hasBack = addState.stepStack && addState.stepStack.length > 0;
  backBtn.style.visibility = hasBack ? "visible" : "hidden";
  backBtn.textContent = id === "addStepTrace" ? "Retake photo" : "Back";
}
document.getElementById("addStepBack").addEventListener("click", () => {
  const stack = addState.stepStack || [];
  const prevId = stack.pop();
  if (!prevId) return;
  goAddStep(prevId, ADD_STEP_LABELS[prevId] || "", { fromBack: true });
  if (prevId === "addStepTrace") setupTraceCanvas(); // safe: doesn't clear existing points
  if (prevId === "addStepSplit") setupSplitCanvas();  // note: this clears the drawn split line
});

/* ---- Step 1: capture (file input or self-timer) ---- */
function finishCapture(source, srcW, srcH) {
  const MAX = 900;
  const scale = Math.min(1, MAX / Math.max(srcW, srcH));
  const w = Math.round(srcW * scale), h = Math.round(srcH * scale);
  const base = document.createElement("canvas");
  base.width = w; base.height = h;
  base.getContext("2d").drawImage(source, 0, 0, w, h);
  addState.baseCanvas = base;
  addState.tracePoints = [];
  addState.tracePathSegments = []; // live-wire path between each consecutive pair of tracePoints
  addState.edgeMap = computeEdgeMap(base);
  goAddStep("addStepTrace", "Trace the item");
  setupTraceCanvas(); // after goAddStep so the wrap has real layout size for zoom-fit
}

document.getElementById("captureInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  URL.revokeObjectURL(url);
  finishCapture(img, img.width, img.height);
});

/* ---- Self-timer camera ---- */
let timerStream = null;
let timerFacing = "user";
let timerSecs = 3;
let timerCountdownHandle = null;

document.getElementById("useTimerBtn").addEventListener("click", async () => {
  goAddStep("addStepTimerCam", "Self-timer photo");
  await startTimerCamera();
});
document.getElementById("timerDurationRow").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll("#timerDurationRow .chip").forEach(c => c.classList.remove("active"));
  chip.classList.add("active");
  timerSecs = parseInt(chip.dataset.secs, 10);
});
document.getElementById("timerFlipCam").addEventListener("click", async () => {
  timerFacing = timerFacing === "user" ? "environment" : "user";
  await startTimerCamera();
});
document.getElementById("timerStartBtn").addEventListener("click", () => {
  if (!timerStream) return;
  runCountdownAndCapture();
});

async function startTimerCamera() {
  stopTimerCamera();
  const video = document.getElementById("timerVideo");
  try {
    timerStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: timerFacing }, audio: false });
    video.srcObject = timerStream;
  } catch (err) {
    alert("Couldn't access the camera. Check this site's camera permission in your browser settings.");
    goAddStep("addStepCapture", "Photograph item");
  }
}
function stopTimerCamera() {
  if (timerCountdownHandle) { clearInterval(timerCountdownHandle); timerCountdownHandle = null; }
  const cd = document.getElementById("timerCountdown");
  if (cd) cd.hidden = true;
  if (timerStream) { timerStream.getTracks().forEach(t => t.stop()); timerStream = null; }
}
function runCountdownAndCapture() {
  const el = document.getElementById("timerCountdown");
  let n = timerSecs;
  el.hidden = false;
  el.textContent = n;
  timerCountdownHandle = setInterval(() => {
    n--;
    if (n <= 0) {
      clearInterval(timerCountdownHandle);
      timerCountdownHandle = null;
      el.hidden = true;
      captureFromVideo();
    } else {
      el.textContent = n;
    }
  }, 1000);
}
function captureFromVideo() {
  const video = document.getElementById("timerVideo");
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return;
  const shot = document.createElement("canvas");
  shot.width = w; shot.height = h;
  const ctx = shot.getContext("2d");
  if (timerFacing === "user") {
    // mirror the front camera so the photo matches what was previewed
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.drawImage(video, 0, 0, w, h);
  stopTimerCamera();
  finishCapture(shot, w, h);
}

/* ---- Step 2: trace ---- */
const traceCanvas = document.getElementById("traceCanvas");
const traceZP = makeZoomPan(traceCanvas, document.getElementById("traceCanvasWrap"));

function setupTraceCanvas() {
  const base = addState.baseCanvas;
  traceCanvas.width = base.width;
  traceCanvas.height = base.height;
  traceZP.reset();
  drawTrace();
}
function drawTrace() {
  const ctx = traceCanvas.getContext("2d");
  ctx.clearRect(0, 0, traceCanvas.width, traceCanvas.height);
  ctx.drawImage(addState.baseCanvas, 0, 0);
  const pts = addState.tracePoints;
  const segs = addState.tracePathSegments;
  if (pts.length) {
    ctx.strokeStyle = "#BD5A3F";
    ctx.fillStyle = "#BD5A3F";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      for (let j = 1; j < seg.length; j++) ctx.lineTo(seg[j].x, seg[j].y);
    }
    ctx.stroke();
    pts.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, i === 0 ? 6 : 3.5, 0, Math.PI * 2);
      ctx.fill();
    });
    if (pts.length > 2) {
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = "rgba(189,90,63,0.6)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, 18, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}
function handleTracePoint(raw) {
  const p = addState.snapEnabled ? (() => { const s = snapToEdge(raw, addState.edgeMap); return { x: s.x, y: s.y }; })() : { x: raw.x, y: raw.y };
  const pts = addState.tracePoints;
  if (pts.length > 2) {
    const d = Math.hypot(raw.x - pts[0].x, raw.y - pts[0].y);
    if (d < 18) {
      document.getElementById("traceConfirm").disabled = false;
      drawTrace();
      return;
    }
  }
  if (pts.length > 0) {
    const prev = pts[pts.length - 1];
    const seg = addState.snapEnabled ? liveWirePath(addState.edgeMap, prev, p) : [prev, p];
    addState.tracePathSegments.push(seg);
  }
  pts.push(p);
  document.getElementById("traceConfirm").disabled = pts.length < 3;
  drawTrace();
}
attachCanvasInteraction(traceCanvas, document.getElementById("traceCanvasWrap"), traceZP, handleTracePoint);
document.getElementById("traceUndo").addEventListener("click", () => {
  addState.tracePoints.pop();
  addState.tracePathSegments.pop();
  document.getElementById("traceConfirm").disabled = addState.tracePoints.length < 3;
  drawTrace();
});
document.getElementById("traceConfirm").addEventListener("click", () => {
  const pts = addState.tracePoints;
  if (pts.length < 3) return;
  // Build the full traced outline: every live-wire segment, plus a closing
  // segment routed from the last tap back to the first.
  const closingSeg = addState.snapEnabled
    ? liveWirePath(addState.edgeMap, pts[pts.length - 1], pts[0])
    : [pts[pts.length - 1], pts[0]];
  const fullPolygon = [];
  addState.tracePathSegments.forEach(seg => fullPolygon.push(...seg));
  fullPolygon.push(...closingSeg);
  addState.fullCutoutCanvas = maskCutout(addState.baseCanvas, fullPolygon);

  if (addState.editMode) {
    // Recropping: category is locked to what it already was; skip straight to
    // split (if this item is a jacket pair) or save.
    if (addState.editPairId) {
      goAddStep("addStepSplit", "Retrace the opening");
      setupSplitCanvas();
    } else {
      const trimmed = trimCanvas(addState.fullCutoutCanvas);
      addState.finalItems = [{
        img: canvasToDataURL(trimmed.canvas),
        width: trimmed.width, height: trimmed.height,
        offsetX: 0, offsetY: 0, pairWidth: trimmed.width, pairHeight: trimmed.height,
        pairId: null, side: null, forcedId: addState.editItemId,
      }];
      showSavePreview();
      goAddStep("addStepSave", "Name & save");
    }
    return;
  }

  const preview = document.getElementById("cutoutPreview");
  const trimmed = trimCanvas(addState.fullCutoutCanvas);
  preview.width = trimmed.width; preview.height = trimmed.height;
  preview.getContext("2d").drawImage(trimmed.canvas, 0, 0);
  goAddStep("addStepCategory", "Choose a category");
});

/* ---- Step 3: category ---- */
document.querySelectorAll(".cat-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    addState.category = btn.dataset.cat;
    document.getElementById("categoryContinue").disabled = false;
    const isOuterwear = addState.category === "outerwear";
    document.getElementById("openFrontRow").hidden = !isOuterwear;
    if (!isOuterwear) document.getElementById("openFrontToggle").checked = false;
  });
});
document.getElementById("categoryContinue").addEventListener("click", () => {
  const wantsSplit = addState.category === "outerwear" && document.getElementById("openFrontToggle").checked;
  addState.openFront = wantsSplit;
  if (wantsSplit) {
    goAddStep("addStepSplit", "Mark the opening");
    setupSplitCanvas();
  } else {
    const trimmed = trimCanvas(addState.fullCutoutCanvas);
    addState.finalItems = [{
      img: canvasToDataURL(trimmed.canvas),
      width: trimmed.width, height: trimmed.height,
      offsetX: 0, offsetY: 0, pairWidth: trimmed.width, pairHeight: trimmed.height,
      pairId: null, side: null,
    }];
    showSavePreview();
    goAddStep("addStepSave", "Name & save");
  }
});

/* ---- Step 4: split (open-front items) ---- */
const splitCanvas = document.getElementById("splitCanvas");
const splitZP = makeZoomPan(splitCanvas, document.getElementById("splitCanvasWrap"));

function setupSplitCanvas() {
  const c = addState.fullCutoutCanvas;
  splitCanvas.width = c.width; splitCanvas.height = c.height;
  addState.splitPoints = [];
  splitZP.reset();
  drawSplit();
}
function drawSplit() {
  const ctx = splitCanvas.getContext("2d");
  ctx.clearRect(0, 0, splitCanvas.width, splitCanvas.height);
  ctx.drawImage(addState.fullCutoutCanvas, 0, 0);
  const pts = addState.splitPoints;
  if (pts.length) {
    ctx.strokeStyle = "#BD5A3F";
    ctx.fillStyle = "#BD5A3F";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    if (pts[1]) ctx.lineTo(pts[1].x, pts[1].y);
    ctx.stroke();
    pts.forEach(p => { ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fill(); });
  }
}
function handleSplitPoint(p) {
  if (addState.splitPoints.length >= 2) addState.splitPoints = [];
  addState.splitPoints.push(p);
  drawSplit();
  document.getElementById("splitConfirm").disabled = addState.splitPoints.length < 2;
}
attachCanvasInteraction(splitCanvas, document.getElementById("splitCanvasWrap"), splitZP, handleSplitPoint);
document.getElementById("splitReset").addEventListener("click", () => {
  addState.splitPoints = [];
  document.getElementById("splitConfirm").disabled = true;
  drawSplit();
});
document.getElementById("splitConfirm").addEventListener("click", () => {
  const [p1, p2] = addState.splitPoints;
  const h = splitCanvas.height, w = splitCanvas.width;
  const dy = p2.y - p1.y;
  let xTop, xBottom;
  if (Math.abs(dy) < 1) {
    xTop = xBottom = (p1.x + p2.x) / 2;
  } else {
    const slope = (p2.x - p1.x) / dy; // dx per dy
    xTop = p1.x + slope * (-1000 - p1.y);
    xBottom = p1.x + slope * (h + 1000 - p1.y);
  }
  const leftMask = [{ x: 0, y: -1000 }, { x: xTop, y: -1000 }, { x: xBottom, y: h + 1000 }, { x: 0, y: h + 1000 }];
  const rightMask = [{ x: xTop, y: -1000 }, { x: w, y: -1000 }, { x: w, y: h + 1000 }, { x: xBottom, y: h + 1000 }];

  const leftFull = maskHalf(addState.fullCutoutCanvas, leftMask);
  const rightFull = maskHalf(addState.fullCutoutCanvas, rightMask);
  const leftTrim = trimCanvas(leftFull);
  const rightTrim = trimCanvas(rightFull);
  const pairId = addState.editMode && addState.editPairId ? addState.editPairId : uuid();
  const leftId = addState.editMode ? addState.editLeftId : null;
  const rightId = addState.editMode ? addState.editRightId : null;

  addState.finalItems = [
    { img: canvasToDataURL(leftTrim.canvas), width: leftTrim.width, height: leftTrim.height,
      offsetX: leftTrim.offsetX, offsetY: leftTrim.offsetY, pairWidth: w, pairHeight: h,
      pairId, side: "left", forcedId: leftId },
    { img: canvasToDataURL(rightTrim.canvas), width: rightTrim.width, height: rightTrim.height,
      offsetX: rightTrim.offsetX, offsetY: rightTrim.offsetY, pairWidth: w, pairHeight: h,
      pairId, side: "right", forcedId: rightId },
  ];
  showSavePreview();
  goAddStep("addStepSave", "Name & save");
});

/* ---- Step 5: save ---- */
function showSavePreview() {
  const wrap = document.getElementById("savePreviewWrap");
  wrap.innerHTML = "";
  addState.finalItems.forEach(it => {
    const c = document.createElement("canvas");
    c.width = it.width; c.height = it.height;
    const img = new Image();
    img.onload = () => c.getContext("2d").drawImage(img, 0, 0);
    img.src = it.img;
    wrap.appendChild(c);
  });
}
document.getElementById("finalSaveBtn").addEventListener("click", async () => {
  const nameInput = document.getElementById("itemNameInput").value.trim();
  const category = addState.editMode ? addState.editCategory : addState.category;
  const groupThumb = await buildGroupThumb();
  const sourcePhoto = canvasToDataURL(addState.baseCanvas);
  const now = Date.now();
  for (const it of addState.finalItems) {
    const record = {
      id: it.forcedId || uuid(),
      pairId: it.pairId,
      side: it.side,
      name: nameInput || CAT_LABEL[category],
      category,
      img: it.img,
      offsetX: it.offsetX, offsetY: it.offsetY,
      pairWidth: it.pairWidth, pairHeight: it.pairHeight,
      width: it.width, height: it.height,
      groupThumb,
      sourcePhoto,
      createdAt: now,
    };
    await idbPut("items", record);
  }
  resetAddFlow();
  showScreen("closet");
  renderClosetGrid();
});
function buildGroupThumb() {
  return new Promise(async (resolve) => {
    if (addState.finalItems.length === 1) {
      resolve(addState.finalItems[0].img);
      return;
    }
    const w = addState.finalItems[0].pairWidth, h = addState.finalItems[0].pairHeight;
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d");
    for (const it of addState.finalItems) {
      const img = await loadImage(it.img);
      ctx.drawImage(img, it.offsetX, it.offsetY);
    }
    resolve(canvasToDataURL(c));
  });
}

/* ============================================================
   CLOSET GRID
   ============================================================ */
let currentFilter = "all";
document.getElementById("filterRow").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  document.querySelectorAll(".chip").forEach(c => c.classList.remove("active"));
  chip.classList.add("active");
  currentFilter = chip.dataset.filter;
  renderClosetGrid();
});

async function getDisplayItems() {
  const all = await idbGetAll("items");
  const seenPairs = new Set();
  const display = [];
  for (const it of all) {
    if (it.pairId) {
      if (seenPairs.has(it.pairId)) continue;
      seenPairs.add(it.pairId);
      display.push({ ...it, isPair: true });
    } else {
      display.push({ ...it, isPair: false });
    }
  }
  display.sort((a, b) => b.createdAt - a.createdAt);
  return display;
}

async function renderClosetGrid() {
  const grid = document.getElementById("closetGrid");
  const empty = document.getElementById("closetEmpty");
  let items = await getDisplayItems();
  if (currentFilter !== "all") items = items.filter(it => it.category === currentFilter);
  grid.innerHTML = "";
  empty.hidden = items.length > 0;
  items.forEach(it => {
    const card = document.createElement("div");
    card.className = "closet-card";
    card.innerHTML = `
      <span class="card-tag"></span>
      <img src="${it.groupThumb || it.img}" alt="${it.name}">
      <span class="card-label">${it.name}</span>
    `;
    card.addEventListener("click", () => openItemSheet(it));
    grid.appendChild(card);
  });
}

/* ---------------- Item edit sheet (rename / recategorize / recrop / delete) ---------------- */
function openItemSheet(displayItem) {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  overlay.innerHTML = `
    <div class="sheet">
      <h2>Edit item</h2>
      <div class="sheet-preview"><img src="${displayItem.groupThumb || displayItem.img}" alt=""></div>
      <div class="field">
        <label>Name</label>
        <input type="text" id="editNameInput" value="${escapeHtml(displayItem.name)}" maxlength="40">
      </div>
      <div class="field">
        <label>Category</label>
        <div class="chiprow" id="editCatRow">
          ${Object.keys(CAT_LABEL).map(c => `<button type="button" class="cat-btn${c === displayItem.category ? " selected" : ""}" data-cat="${c}">${CAT_LABEL[c]}</button>`).join("")}
        </div>
      </div>
      <div class="sheetactions">
        <button class="btn danger" id="itemDeleteBtn" type="button">Delete</button>
        <button class="btn ghost" id="itemRecropBtn" type="button">Recrop</button>
      </div>
      <div class="sheetactions">
        <button class="btn ghost" id="itemCancelBtn" type="button">Cancel</button>
        <button class="btn primary" id="itemSaveBtn" type="button">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  let chosenCat = displayItem.category;
  overlay.querySelectorAll("#editCatRow .cat-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      chosenCat = btn.dataset.cat;
      overlay.querySelectorAll("#editCatRow .cat-btn").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    });
  });

  overlay.querySelector("#itemCancelBtn").addEventListener("click", () => overlay.remove());

  overlay.querySelector("#itemDeleteBtn").addEventListener("click", async () => {
    if (!confirm(`Delete "${displayItem.name}" from your closet? This can't be undone.`)) return;
    await deleteItem(displayItem);
    overlay.remove();
    renderClosetGrid();
  });

  overlay.querySelector("#itemSaveBtn").addEventListener("click", async () => {
    const newName = overlay.querySelector("#editNameInput").value.trim() || CAT_LABEL[chosenCat];
    await renameAndRecategorize(displayItem, newName, chosenCat);
    overlay.remove();
    renderClosetGrid();
  });

  overlay.querySelector("#itemRecropBtn").addEventListener("click", async () => {
    overlay.remove();
    await startRecrop(displayItem);
  });
}

async function renameAndRecategorize(displayItem, newName, newCategory) {
  const all = await idbGetAll("items");
  const targets = displayItem.pairId
    ? all.filter(x => x.pairId === displayItem.pairId)
    : all.filter(x => x.id === displayItem.id);
  for (const rec of targets) {
    rec.name = newName;
    rec.category = newCategory;
    await idbPut("items", rec);
  }
}

async function deleteItem(displayItem) {
  const all = await idbGetAll("items");
  const idsToDelete = (displayItem.pairId ? all.filter(x => x.pairId === displayItem.pairId) : all.filter(x => x.id === displayItem.id))
    .map(x => x.id);
  for (const id of idsToDelete) await idbDelete("items", id);

  // drop any placed instances on the outfit canvas that pointed at the deleted item(s)
  const saved = await idbGet("state", "currentOutfit");
  if (saved && saved.instances) {
    const cleaned = saved.instances.filter(i => !idsToDelete.includes(i.itemId));
    if (cleaned.length !== saved.instances.length) {
      await idbPut("state", { key: "currentOutfit", instances: cleaned });
    }
  }
  placedInstances = placedInstances.filter(i => !idsToDelete.includes(i.itemId));
}

async function startRecrop(displayItem) {
  if (!displayItem.sourcePhoto) {
    alert("This item was saved before recropping was supported, so there's no original photo to re-trace. Delete and re-add it to enable recropping.");
    return;
  }
  const img = await loadImage(displayItem.sourcePhoto);
  addState = {
    photoImg: img, baseCanvas: null, tracePoints: [], fullCutoutCanvas: null,
    category: displayItem.category, openFront: false, splitPoints: [], finalItems: [],
    editMode: true,
    editPairId: displayItem.pairId || null,
    editItemId: displayItem.pairId ? null : displayItem.id,
    editLeftId: null, editRightId: null,
    editName: displayItem.name, editCategory: displayItem.category,
    snapEnabled: true,
    stepStack: [],
  };
  setSnapToggleUI(true);
  if (displayItem.pairId) {
    const all = await idbGetAll("items");
    const left = all.find(x => x.pairId === displayItem.pairId && x.side === "left");
    const right = all.find(x => x.pairId === displayItem.pairId && x.side === "right");
    addState.editLeftId = left ? left.id : uuid();
    addState.editRightId = right ? right.id : uuid();
  }
  document.getElementById("itemNameInput").value = displayItem.name;
  showScreen("add");
  finishCapture(img, img.width, img.height);
}

/* ============================================================
   OUTFIT CANVAS
   ============================================================ */
const outfitCanvas = document.getElementById("outfitCanvas");
const dropHint = document.getElementById("outfitDropHint");
let placedInstances = []; // {instanceId, groupId, itemId, x, y, w, h, z, side?}
let itemsCache = {}; // id -> item record

async function loadItemsCache() {
  const all = await idbGetAll("items");
  itemsCache = {};
  all.forEach(it => { itemsCache[it.id] = it; });
}

async function renderTray() {
  await loadItemsCache();
  const tray = document.getElementById("outfitTray");
  const items = await getDisplayItems();
  tray.innerHTML = "";
  items.forEach(it => {
    const el = document.createElement("div");
    el.className = "tray-item";
    el.innerHTML = `<img src="${it.groupThumb || it.img}" alt="${it.name}">`;
    el.title = it.name;
    el.addEventListener("click", () => addItemToOutfit(it));
    tray.appendChild(el);
  });
  await restoreOutfitState();
}

async function addItemToOutfit(displayItem) {
  await loadItemsCache();
  dropHint.style.display = "none";
  const canvasW = outfitCanvas.clientWidth, canvasH = outfitCanvas.clientHeight;
  const groupId = uuid();
  const targetH = displayItem.category === "body" ? canvasH * 0.8 : canvasH * 0.42;

  const members = displayItem.pairId
    ? [itemsCache[displayItem.id], Object.values(itemsCache).find(x => x.pairId === displayItem.pairId && x.id !== displayItem.id)]
    : [displayItem];

  if (!members[0]) return; // item no longer exists (deleted elsewhere); nothing to place

  const pairW = members[0].pairWidth, pairH = members[0].pairHeight;
  const scale = targetH / pairH;
  const groupX = (canvasW - pairW * scale) / 2;
  const groupY = (canvasH - pairH * scale) / 2;

  members.forEach(m => {
    if (!m) return;
    placedInstances.push({
      instanceId: uuid(),
      groupId,
      itemId: m.id,
      category: m.category,
      x: groupX + m.offsetX * scale,
      y: groupY + m.offsetY * scale,
      w: m.width * scale,
      h: m.height * scale,
      z: CAT_ORDER[m.category] ?? 5,
    });
  });
  renderOutfitCanvas();
  saveOutfitState();
}

function renderOutfitCanvas() {
  outfitCanvas.querySelectorAll(".outfit-item").forEach(el => el.remove());
  placedInstances
    .slice()
    .sort((a, b) => a.z - b.z)
    .forEach(inst => {
      const item = itemsCache[inst.itemId];
      if (!item) return;
      const el = document.createElement("div");
      el.className = "outfit-item";
      el.style.left = inst.x + "px";
      el.style.top = inst.y + "px";
      el.style.width = inst.w + "px";
      el.style.height = inst.h + "px";
      el.style.zIndex = inst.z;
      el.dataset.instanceId = inst.instanceId;
      el.innerHTML = `<img src="${item.img}" alt=""><button class="item-delete" type="button" aria-label="Remove">&times;</button>`;
      attachDrag(el, inst);
      outfitCanvas.appendChild(el);
    });
  dropHint.style.display = placedInstances.length ? "none" : "flex";
}

function attachDrag(el, inst) {
  const pointers = new Map();
  let dragging = false, pinching = false;
  let groupMembers = [];
  let dragStart = null;
  let pinchStart = null;

  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  const delBtn = el.querySelector(".item-delete");
  delBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    placedInstances = placedInstances.filter(i => i.groupId !== inst.groupId);
    renderOutfitCanvas();
    saveOutfitState();
  });

  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".item-delete")) return;
    e.preventDefault();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    groupMembers = placedInstances.filter(i => i.groupId === inst.groupId);
    if (pointers.size === 1) {
      dragging = true;
      dragStart = { x: e.clientX, y: e.clientY };
      groupMembers.forEach(m => { m._origX = m.x; m._origY = m.y; });
      el.classList.add("dragging");
    } else if (pointers.size === 2) {
      dragging = false;
      el.classList.remove("dragging");
      pinching = true;
      const [a, b] = [...pointers.values()];
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      groupMembers.forEach(m => {
        minX = Math.min(minX, m.x); minY = Math.min(minY, m.y);
        maxX = Math.max(maxX, m.x + m.w); maxY = Math.max(maxY, m.y + m.h);
      });
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      pinchStart = {
        dist: dist(a, b),
        cx, cy,
        midX: (a.x + b.x) / 2, midY: (a.y + b.y) / 2, // finger midpoint, in client px
        members: groupMembers.map(m => ({ id: m.instanceId, w: m.w, h: m.h, offX: m.x - cx, offY: m.y - cy })),
      };
    }
  });
  el.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinching && pointers.size >= 2 && pinchStart) {
      const [a, b] = [...pointers.values()];
      const d = dist(a, b);
      if (pinchStart.dist > 0) {
        let factor = d / pinchStart.dist;
        factor = Math.max(0.3, Math.min(4, factor));
        const curMidX = (a.x + b.x) / 2, curMidY = (a.y + b.y) / 2;
        const panX = curMidX - pinchStart.midX, panY = curMidY - pinchStart.midY;
        pinchStart.members.forEach(pm => {
          const m = groupMembers.find(x => x.instanceId === pm.id);
          if (!m) return;
          m.w = Math.max(24, pm.w * factor);
          m.h = Math.max(24, pm.h * factor);
          m.x = pinchStart.cx + pm.offX * factor + panX;
          m.y = pinchStart.cy + pm.offY * factor + panY;
          const memEl = outfitCanvas.querySelector(`[data-instance-id="${m.instanceId}"]`);
          if (memEl) {
            memEl.style.left = m.x + "px"; memEl.style.top = m.y + "px";
            memEl.style.width = m.w + "px"; memEl.style.height = m.h + "px";
          }
        });
      }
    } else if (dragging && pointers.size === 1 && dragStart) {
      const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
      groupMembers.forEach(m => {
        m.x = m._origX + dx;
        m.y = m._origY + dy;
        const memEl = outfitCanvas.querySelector(`[data-instance-id="${m.instanceId}"]`);
        if (memEl) { memEl.style.left = m.x + "px"; memEl.style.top = m.y + "px"; }
      });
    }
  });
  function endPointer(e) {
    pointers.delete(e.pointerId);
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    if (pointers.size < 2) pinching = false;
    if (pointers.size === 0) {
      const shouldSave = dragging || pinching;
      dragging = false;
      el.classList.remove("dragging");
      if (shouldSave) saveOutfitState();
    }
  }
  el.addEventListener("pointerup", endPointer);
  el.addEventListener("pointercancel", endPointer);
}

document.getElementById("clearOutfitBtn").addEventListener("click", () => {
  placedInstances = [];
  renderOutfitCanvas();
  saveOutfitState();
});
document.getElementById("saveOutfitBtn").addEventListener("click", async () => {
  await idbPut("state", { key: "savedLook-" + Date.now(), instances: placedInstances });
  const btn = document.getElementById("saveOutfitBtn");
  const orig = btn.textContent;
  btn.textContent = "Saved!";
  setTimeout(() => { btn.textContent = orig; }, 1000);
});

async function saveOutfitState() {
  await idbPut("state", { key: "currentOutfit", instances: placedInstances });
}
async function restoreOutfitState() {
  const saved = await idbGet("state", "currentOutfit");
  placedInstances = (saved && saved.instances) || [];
  renderOutfitCanvas();
}

/* ============================================================
   INIT
   ============================================================ */
(async function init() {
  await openDB();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  renderClosetGrid();
})();