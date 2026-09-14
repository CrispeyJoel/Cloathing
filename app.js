/* ============================================================
   Closet — storage, trace/cutout, split, outfit canvas
   ============================================================ */

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

/* ---------------- Screen / tab navigation ---------------- */
const screens = {
  closet: document.getElementById("screen-closet"),
  outfit: document.getElementById("screen-outfit"),
  add: document.getElementById("screen-add"),
};
function showScreen(name) {
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

/* ============================================================
   ADD FLOW STATE
   ============================================================ */
let addState = {};

function resetAddFlow() {
  addState = {
    photoImg: null,
    baseCanvas: null,     // photo drawn at working resolution
    tracePoints: [],
    fullCutoutCanvas: null, // masked cutout at working resolution (untrimmed)
    category: null,
    openFront: false,
    splitPoints: [],
    finalItems: [],       // one item (normal) or two items (split pair)
  };
  document.querySelectorAll(".add-step").forEach(s => s.classList.remove("active"));
  document.getElementById("addStepCapture").classList.add("active");
  document.getElementById("addStepLabel").textContent = "Photograph item";
  document.getElementById("captureInput").value = "";
  document.getElementById("traceConfirm").disabled = true;
  document.getElementById("itemNameInput").value = "";
  document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("selected"));
  document.getElementById("categoryContinue").disabled = true;
  document.getElementById("openFrontRow").hidden = true;
  document.getElementById("openFrontToggle").checked = false;
}

function goAddStep(id, label) {
  document.querySelectorAll(".add-step").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.getElementById("addStepLabel").textContent = label;
}

/* ---- Step 1: capture ---- */
document.getElementById("captureInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const url = URL.createObjectURL(file);
  const img = await loadImage(url);
  URL.revokeObjectURL(url);
  addState.photoImg = img;

  const MAX = 900;
  const scale = Math.min(1, MAX / Math.max(img.width, img.height));
  const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
  const base = document.createElement("canvas");
  base.width = w; base.height = h;
  base.getContext("2d").drawImage(img, 0, 0, w, h);
  addState.baseCanvas = base;
  addState.tracePoints = [];
  addState.edgeMap = computeEdgeMap(base);

  setupTraceCanvas();
  goAddStep("addStepTrace", "Trace the item");
});

/* ---- Step 2: trace ---- */
const traceCanvas = document.getElementById("traceCanvas");
function setupTraceCanvas() {
  const base = addState.baseCanvas;
  traceCanvas.width = base.width;
  traceCanvas.height = base.height;
  drawTrace();
}
function drawTrace() {
  const ctx = traceCanvas.getContext("2d");
  ctx.clearRect(0, 0, traceCanvas.width, traceCanvas.height);
  ctx.drawImage(addState.baseCanvas, 0, 0);
  const pts = addState.tracePoints;
  if (pts.length) {
    ctx.strokeStyle = "#BD5A3F";
    ctx.fillStyle = "#BD5A3F";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
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
function canvasPointFromEvent(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
  const t = e.touches ? e.touches[0] : e;
  return { x: (t.clientX - rect.left) * sx, y: (t.clientY - rect.top) * sy };
}
traceCanvas.addEventListener("pointerdown", (e) => {
  const raw = canvasPointFromEvent(traceCanvas, e);
  const snapped = snapToEdge(raw, addState.edgeMap);
  const p = { x: snapped.x, y: snapped.y };
  const pts = addState.tracePoints;
  if (pts.length > 2) {
    const d = Math.hypot(raw.x - pts[0].x, raw.y - pts[0].y);
    if (d < 18) {
      document.getElementById("traceConfirm").disabled = false;
      drawTrace();
      return;
    }
  }
  pts.push(p);
  document.getElementById("traceConfirm").disabled = pts.length < 3;
  drawTrace();
});
document.getElementById("traceUndo").addEventListener("click", () => {
  addState.tracePoints.pop();
  document.getElementById("traceConfirm").disabled = addState.tracePoints.length < 3;
  drawTrace();
});
document.getElementById("traceConfirm").addEventListener("click", () => {
  const pts = addState.tracePoints;
  if (pts.length < 3) return;
  addState.fullCutoutCanvas = maskCutout(addState.baseCanvas, pts);
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
    setupSplitCanvas();
    goAddStep("addStepSplit", "Mark the opening");
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
function setupSplitCanvas() {
  const c = addState.fullCutoutCanvas;
  splitCanvas.width = c.width; splitCanvas.height = c.height;
  addState.splitPoints = [];
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
splitCanvas.addEventListener("pointerdown", (e) => {
  const p = canvasPointFromEvent(splitCanvas, e);
  if (addState.splitPoints.length >= 2) addState.splitPoints = [];
  addState.splitPoints.push(p);
  drawSplit();
  document.getElementById("splitConfirm").disabled = addState.splitPoints.length < 2;
});
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
  const pairId = uuid();

  addState.finalItems = [
    { img: canvasToDataURL(leftTrim.canvas), width: leftTrim.width, height: leftTrim.height,
      offsetX: leftTrim.offsetX, offsetY: leftTrim.offsetY, pairWidth: w, pairHeight: h,
      pairId, side: "left" },
    { img: canvasToDataURL(rightTrim.canvas), width: rightTrim.width, height: rightTrim.height,
      offsetX: rightTrim.offsetX, offsetY: rightTrim.offsetY, pairWidth: w, pairHeight: h,
      pairId, side: "right" },
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
  const category = addState.category;
  const groupThumb = await buildGroupThumb();
  const now = Date.now();
  for (const it of addState.finalItems) {
    const record = {
      id: uuid(),
      pairId: it.pairId,
      side: it.side,
      name: nameInput || CAT_LABEL[category],
      category,
      img: it.img,
      offsetX: it.offsetX, offsetY: it.offsetY,
      pairWidth: it.pairWidth, pairHeight: it.pairHeight,
      width: it.width, height: it.height,
      groupThumb,
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
    card.addEventListener("click", () => addItemToOutfit(it));
    grid.appendChild(card);
  });
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
  let startX, startY, groupMembers, dragged;

  el.querySelector(".item-delete").addEventListener("pointerdown", (e) => {
    e.stopPropagation();
  });
  el.querySelector(".item-delete").addEventListener("click", (e) => {
    e.stopPropagation();
    placedInstances = placedInstances.filter(i => i.groupId !== inst.groupId);
    renderOutfitCanvas();
    saveOutfitState();
  });

  el.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".item-delete")) return;
    e.preventDefault();
    dragged = false;
    el.classList.add("dragging");
    startX = e.clientX; startY = e.clientY;
    groupMembers = placedInstances.filter(i => i.groupId === inst.groupId);
    groupMembers.forEach(m => { m._origX = m.x; m._origY = m.y; });
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
  });
  el.addEventListener("pointermove", (e) => {
    if (!el.classList.contains("dragging")) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragged = true;
    groupMembers.forEach(m => {
      m.x = m._origX + dx;
      m.y = m._origY + dy;
      const memEl = outfitCanvas.querySelector(`[data-instance-id="${m.instanceId}"]`);
      if (memEl) { memEl.style.left = m.x + "px"; memEl.style.top = m.y + "px"; }
    });
  });
  el.addEventListener("pointerup", (e) => {
    el.classList.remove("dragging");
    try { el.releasePointerCapture(e.pointerId); } catch (err) {}
    if (dragged) saveOutfitState();
  });
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