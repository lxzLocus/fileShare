const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const browseBtn = document.getElementById("browseBtn");
const expirySelect = document.getElementById("expirySelect");
const uploadQueue = document.getElementById("uploadQueue");
const fileGrid = document.getElementById("fileGrid");
const emptyMsg = document.getElementById("empty");
const countEl = document.getElementById("count");
const refreshBtn = document.getElementById("refreshBtn");
const qrToggle = document.getElementById("qrToggle");
const qrPanel = document.getElementById("qrPanel");
const qrCode = document.getElementById("qrCode");
const urlList = document.getElementById("urlList");
const viewGridBtn = document.getElementById("viewGrid");
const viewListBtn = document.getElementById("viewList");
const modal = document.getElementById("modal");
const modalMsg = document.getElementById("modalMsg");
const modalOk = document.getElementById("modalOk");
const modalCancel = document.getElementById("modalCancel");

let viewMode = localStorage.getItem("viewMode") || "grid"; // "grid" | "list"
let lastFiles = [];

// ---------- ユーティリティ ----------
function fmtSize(bytes) {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtRemaining(expiresAt) {
  if (!expiresAt) return { text: "無期限", cls: "never" };
  const ms = expiresAt - Date.now();
  if (ms <= 0) return { text: "まもなく削除", cls: "soon" };
  const min = Math.floor(ms / 60000);
  if (min < 60) return { text: `あと${min}分`, cls: "soon" };
  const hr = Math.floor(min / 60);
  if (hr < 24) return { text: `あと${hr}時間`, cls: hr < 2 ? "soon" : "" };
  const d = Math.floor(hr / 24);
  return { text: `あと${d}日`, cls: "" };
}

const EXT_ICONS = {
  pdf: "📕", zip: "🗜️", rar: "🗜️", "7z": "🗜️", mp3: "🎵", wav: "🎵",
  mp4: "🎬", mov: "🎬", avi: "🎬", mkv: "🎬", doc: "📘", docx: "📘",
  xls: "📗", xlsx: "📗", ppt: "📙", pptx: "📙", txt: "📄", csv: "📄",
  json: "🧾", js: "🧾", html: "🧾", css: "🧾",
};
function iconFor(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  return EXT_ICONS[ext] || "📦";
}

// ---------- 一覧取得 ----------
async function loadFiles() {
  try {
    const res = await fetch("/api/files");
    const { files } = await res.json();
    lastFiles = files;
    renderFiles(files);
  } catch (e) {
    console.error(e);
  }
}

function thumbEl(f) {
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  // hasThumb 不在の旧サーバ応答でも画像はサムネ表示する
  const canThumb = f.hasThumb ?? f.isImage;
  if (canThumb) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.src = `/api/thumb/${f.id}`;
    img.alt = f.name;
    const icon = f.isVideo ? "🎬" : "🖼️";
    let triedRaw = false;
    img.onerror = () => {
      // /api/thumb が404等で失敗 → 画像なら原本で再試行、それでもダメならアイコン
      if (!triedRaw && f.isImage) {
        triedRaw = true;
        img.src = `/api/raw/${f.id}`;
      } else {
        thumb.innerHTML = `<span class="ficon">${icon}</span>`;
      }
    };
    thumb.appendChild(img);
    if (f.isVideo) {
      const play = document.createElement("span");
      play.className = "play-badge";
      play.textContent = "▶";
      thumb.appendChild(play);
    }
  } else {
    thumb.innerHTML = `<span class="ficon">${f.isVideo ? "🎬" : iconFor(f.name)}</span>`;
  }
  return thumb;
}

function gridCard(f) {
  const card = document.createElement("div");
  card.className = "card";

  const rem = fmtRemaining(f.expiresAt);
  const body = document.createElement("div");
  body.className = "card-body";
  body.innerHTML = `
    <div class="fname" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
    <div class="meta">${fmtSize(f.size)}</div>
    <div class="expiry ${rem.cls}">⏱ ${rem.text}</div>`;

  const actions = document.createElement("div");
  actions.className = "card-actions";
  const dl = document.createElement("a");
  dl.className = "btn-dl";
  dl.href = `/api/file/${f.id}`;
  dl.textContent = "⬇ 保存";
  const del = document.createElement("button");
  del.className = "btn-del";
  del.textContent = "🗑";
  del.onclick = () => deleteFile(f.id, f.name);
  actions.append(dl, del);

  card.append(thumbEl(f), body, actions);
  return card;
}

function listRow(f) {
  const row = document.createElement("div");
  row.className = "row";

  const rem = fmtRemaining(f.expiresAt);
  const info = document.createElement("div");
  info.className = "row-info";
  info.innerHTML = `
    <div class="fname" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
    <div class="row-meta">
      <span class="meta">${fmtSize(f.size)}</span>
      <span class="expiry ${rem.cls}">⏱ ${rem.text}</span>
    </div>`;

  const actions = document.createElement("div");
  actions.className = "row-actions";
  const dl = document.createElement("a");
  dl.className = "btn-dl";
  dl.href = `/api/file/${f.id}`;
  dl.textContent = "⬇ 保存";
  const del = document.createElement("button");
  del.className = "btn-del";
  del.textContent = "🗑";
  del.onclick = () => deleteFile(f.id, f.name);
  actions.append(dl, del);

  row.append(thumbEl(f), info, actions);
  return row;
}

function renderFiles(files) {
  fileGrid.innerHTML = "";
  fileGrid.className = viewMode === "list" ? "list" : "grid";
  countEl.textContent = files.length;
  emptyMsg.classList.toggle("hidden", files.length > 0);
  viewGridBtn.classList.toggle("active", viewMode === "grid");
  viewListBtn.classList.toggle("active", viewMode === "list");

  for (const f of files) {
    fileGrid.appendChild(viewMode === "list" ? listRow(f) : gridCard(f));
  }
}

function setView(mode) {
  viewMode = mode;
  localStorage.setItem("viewMode", mode);
  renderFiles(lastFiles);
}
viewGridBtn.addEventListener("click", () => setView("grid"));
viewListBtn.addEventListener("click", () => setView("list"));

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ブラウザ内の確認ポップアップ（Promise<boolean>）
let modalResolve = null;
function confirmDialog(message) {
  modalMsg.textContent = message;
  modal.classList.remove("hidden");
  modalOk.focus();
  return new Promise((resolve) => { modalResolve = resolve; });
}
function closeModal(result) {
  modal.classList.add("hidden");
  if (modalResolve) { modalResolve(result); modalResolve = null; }
}
modalOk.addEventListener("click", () => closeModal(true));
modalCancel.addEventListener("click", () => closeModal(false));
modal.addEventListener("click", (e) => { if (e.target === modal) closeModal(false); });
document.addEventListener("keydown", (e) => {
  if (modal.classList.contains("hidden")) return;
  if (e.key === "Escape") closeModal(false);
  if (e.key === "Enter") closeModal(true);
});

async function deleteFile(id, name) {
  const ok = await confirmDialog(`「${name}」を削除しますか？この操作は取り消せません。`);
  if (!ok) return;
  await fetch(`/api/file/${id}`, { method: "DELETE" });
  loadFiles();
}

// ---------- アップロード ----------
function uploadFiles(files) {
  if (!files || files.length === 0) return;
  const expires = expirySelect.value;
  for (const file of files) uploadOne(file, expires);
}

function uploadOne(file, expires) {
  const row = document.createElement("div");
  row.className = "queue-item";
  row.innerHTML = `
    <span class="qname">${escapeHtml(file.name)}</span>
    <span class="meta">${fmtSize(file.size)}</span>
    <div class="bar"><span></span></div>`;
  uploadQueue.prepend(row);
  const bar = row.querySelector(".bar > span");

  const form = new FormData();
  form.append("files", file);
  form.append("expires", expires);

  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/upload");
  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) bar.style.width = `${(e.loaded / e.total) * 100}%`;
  };
  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      row.classList.add("done");
      bar.style.width = "100%";
      setTimeout(() => row.remove(), 1200);
      loadFiles();
    } else {
      let msg = "失敗";
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
      row.classList.add("err");
      row.querySelector(".qname").textContent = `${file.name} — ${msg}`;
    }
  };
  xhr.onerror = () => { row.classList.add("err"); };
  xhr.send(form);
}

// ---------- ドラッグ&ドロップ ----------
["dragenter", "dragover"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add("drag");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "dragleave" && dropzone.contains(e.relatedTarget)) return;
    dropzone.classList.remove("drag");
  })
);
dropzone.addEventListener("drop", (e) => uploadFiles(e.dataTransfer.files));
dropzone.addEventListener("click", () => fileInput.click());
browseBtn.addEventListener("click", (e) => { e.stopPropagation(); fileInput.click(); });
fileInput.addEventListener("change", () => { uploadFiles(fileInput.files); fileInput.value = ""; });

// ページ全体へのドロップで誤って開くのを防止
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

refreshBtn.addEventListener("click", loadFiles);

// ---------- QR / アクセスURL ----------
async function loadInfo() {
  try {
    const res = await fetch("/api/info");
    const { urls } = await res.json();
    const best = urls[0] || `${location.origin}`;
    urlList.innerHTML = "";
    const shown = urls.length ? urls : [location.origin];
    for (const u of shown) {
      const li = document.createElement("li");
      li.innerHTML = `<a href="${u}">${u}</a>`;
      urlList.appendChild(li);
    }
    const qrTarget = urls[0] || location.origin;
    const r = await fetch(`/api/qr?url=${encodeURIComponent(qrTarget)}`);
    qrCode.innerHTML = await r.text();
  } catch (e) {
    console.error(e);
  }
}

qrToggle.addEventListener("click", () => {
  qrPanel.classList.toggle("hidden");
  if (!qrPanel.classList.contains("hidden") && !qrCode.innerHTML) loadInfo();
});

// 期限表示を定期更新
setInterval(loadFiles, 30000);
loadFiles();
