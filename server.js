import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// データ保存先（Dockerではボリュームをマウントして永続化）
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const THUMB_DIR = path.join(DATA_DIR, "thumbs");
const DB_FILE = path.join(DATA_DIR, "db.json");
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5GB / 1ファイル

// 画像サムネ生成（sharpがあれば使う。無ければ元画像にフォールバック）
let sharp = null;
try {
  sharp = (await import("sharp")).default;
  console.log("sharp 利用可能: サムネイルを生成します");
} catch {
  console.log("sharp なし: 画像は元データをサムネイル表示します");
}

// 動画サムネ生成用 ffmpeg の解決
// 優先順: FFMPEG_PATH(環境変数) → ffmpeg-static(同梱) → PATH上の "ffmpeg"
// ※ Alpine/LXC ではシステムの ffmpeg を FFMPEG_PATH で指すのが確実
let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) {
  try {
    ffmpegPath = (await import("ffmpeg-static")).default;
  } catch {
    ffmpegPath = null;
  }
}
const canVideoThumb = !!(ffmpegPath && sharp);
console.log(
  canVideoThumb
    ? `動画サムネ: 有効 (${ffmpegPath})`
    : "動画サムネ: 無効 (ffmpeg または sharp 無し → アイコン表示)"
);

// 動画から1フレーム取り出してPNGバッファで返す（spawnでパイプ受け）
function extractVideoFrame(srcPath, seekSec) {
  return new Promise((resolve, reject) => {
    const args = [
      "-ss", String(seekSec),
      "-i", srcPath,
      "-frames:v", "1",
      "-f", "image2pipe",
      "-vcodec", "png",
      "pipe:1",
    ];
    const ff = spawn(ffmpegPath, args, { windowsHide: true });
    const chunks = [];
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.on("error", reject);
    ff.on("close", () => {
      const buf = Buffer.concat(chunks);
      buf.length > 0 ? resolve(buf) : reject(new Error("no frame"));
    });
  });
}

// ---------- 永続化（軽量JSON DB） ----------
let db = { files: [] };
let saveTimer = null;

async function loadDb() {
  try {
    const raw = await fs.readFile(DB_FILE, "utf8");
    db = JSON.parse(raw);
    if (!Array.isArray(db.files)) db.files = [];
  } catch {
    db = { files: [] };
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2));
    } catch (e) {
      console.error("DB保存失敗:", e);
    }
  }, 200);
}

// ファイル実体＋サムネを削除
async function removeFileData(f) {
  try {
    await fs.unlink(path.join(UPLOAD_DIR, f.stored));
  } catch {
    /* 既に無ければ無視 */
  }
  try {
    await fs.unlink(path.join(THUMB_DIR, `${f.id}.webp`));
  } catch {
    /* サムネ未生成なら無視 */
  }
}

// ---------- 期限切れの自動削除 ----------
async function cleanupExpired() {
  const now = Date.now();
  const expired = db.files.filter((f) => f.expiresAt && f.expiresAt <= now);
  if (expired.length === 0) return;
  for (const f of expired) {
    await removeFileData(f);
  }
  const expiredIds = new Set(expired.map((f) => f.id));
  db.files = db.files.filter((f) => !expiredIds.has(f.id));
  scheduleSave();
  console.log(`自動削除: ${expired.length}件`);
}

// ---------- アップロード設定 ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    // 元の拡張子を保持
    const ext = path.extname(Buffer.from(file.originalname, "latin1").toString("utf8"));
    cb(null, id + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE } });

// 期限プリセット（秒）。null = 無期限
const EXPIRY_PRESETS = {
  "10m": 10 * 60,
  "1h": 60 * 60,
  "6h": 6 * 60 * 60,
  "1d": 24 * 60 * 60,
  "7d": 7 * 24 * 60 * 60,
  "30d": 30 * 24 * 60 * 60,
  never: null,
};

function publicFile(f) {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mime: f.mime,
    createdAt: f.createdAt,
    expiresAt: f.expiresAt,
    isImage: (f.mime || "").startsWith("image/"),
    isVideo: (f.mime || "").startsWith("video/"),
    // この種別はサムネ画像を持てる（フロントは /api/thumb を参照）
    hasThumb:
      (f.mime || "").startsWith("image/") ||
      ((f.mime || "").startsWith("video/") && canVideoThumb),
  };
}

// ---------- サーバ ----------
const app = express();
// 静的ファイルは毎回再検証（ETag）させ、更新後のJS/CSSが確実に反映されるように
app.use(
  express.static(path.join(__dirname, "public"), {
    etag: true,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  })
);

// 一覧
app.get("/api/files", (req, res) => {
  const list = db.files
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicFile);
  res.json({ files: list });
});

// アクセス情報（LAN URL一覧）
app.get("/api/info", (req, res) => {
  res.json({ urls: getNetworkUrls(req), maxFileSize: MAX_FILE_SIZE });
});

// QRコード（SVG）
app.get("/api/qr", async (req, res) => {
  const url = String(req.query.url || "");
  if (!url) return res.status(400).send("url required");
  try {
    const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 220 });
    res.type("svg").send(svg);
  } catch {
    res.status(500).send("qr error");
  }
});

// アップロード
app.post("/api/upload", upload.array("files"), (req, res) => {
  const preset = req.body.expires || "1d";
  const seconds = preset in EXPIRY_PRESETS ? EXPIRY_PRESETS[preset] : EXPIRY_PRESETS["1d"];
  const now = Date.now();
  const created = [];
  for (const file of req.files || []) {
    const name = Buffer.from(file.originalname, "latin1").toString("utf8");
    const entry = {
      id: path.basename(file.filename, path.extname(file.filename)),
      stored: file.filename,
      name,
      size: file.size,
      mime: file.mimetype,
      createdAt: now,
      expiresAt: seconds == null ? null : now + seconds * 1000,
    };
    db.files.push(entry);
    created.push(publicFile(entry));
  }
  scheduleSave();
  res.json({ files: created });
});

function findFile(id) {
  return db.files.find((f) => f.id === id);
}

// 表示（インライン：サムネ/プレビュー用）
app.get("/api/raw/:id", (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).send("not found");
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  createReadStream(path.join(UPLOAD_DIR, f.stored)).on("error", () => res.sendStatus(404)).pipe(res);
});

// 画像をリサイズしてwebpサムネを書き出す
async function makeImageThumb(srcPath, thumbPath) {
  await sharp(srcPath)
    .rotate() // EXIF向き補正
    .resize(400, 400, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 72 })
    .toFile(thumbPath);
}

// 動画から1フレーム取り出してwebpサムネを書き出す
async function makeVideoThumb(srcPath, thumbPath) {
  let frame;
  try {
    frame = await extractVideoFrame(srcPath, 1); // まず1秒地点
  } catch {
    frame = await extractVideoFrame(srcPath, 0); // 短い動画は先頭フレーム
  }
  await sharp(frame)
    .resize(400, 400, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 72 })
    .toFile(thumbPath);
}

// サムネイル（画像/動画をリサイズしてキャッシュ）
app.get("/api/thumb/:id", async (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).send("not found");
  const mime = f.mime || "";
  const isImage = mime.startsWith("image/");
  const isVideo = mime.startsWith("video/");

  // 生成不可: 画像は原本へ、動画はアイコン表示させたいので404
  if (isImage && !sharp) return res.redirect(302, `/api/raw/${f.id}`);
  if (isVideo && !canVideoThumb) return res.status(404).send("no thumb");
  if (!isImage && !isVideo) return res.status(404).send("no thumb");

  const thumbPath = path.join(THUMB_DIR, `${f.id}.webp`);
  try {
    await fs.access(thumbPath);
  } catch {
    try {
      const src = path.join(UPLOAD_DIR, f.stored);
      if (isVideo) await makeVideoThumb(src, thumbPath);
      else await makeImageThumb(src, thumbPath);
    } catch {
      // 生成失敗: 画像は原本へ、動画はアイコンへ(404)
      return isImage ? res.redirect(302, `/api/raw/${f.id}`) : res.status(404).send("thumb failed");
    }
  }
  res.setHeader("Content-Type", "image/webp");
  res.setHeader("Cache-Control", "public, max-age=86400");
  createReadStream(thumbPath).on("error", () => res.sendStatus(404)).pipe(res);
});

// ダウンロード（添付）
app.get("/api/file/:id", (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).send("not found");
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  createReadStream(path.join(UPLOAD_DIR, f.stored)).on("error", () => res.sendStatus(404)).pipe(res);
});

// 手動削除
app.delete("/api/file/:id", async (req, res) => {
  const f = findFile(req.params.id);
  if (!f) return res.status(404).json({ error: "not found" });
  await removeFileData(f);
  db.files = db.files.filter((x) => x.id !== f.id);
  scheduleSave();
  res.json({ ok: true });
});

// multerのエラー（サイズ超過など）
app.use((err, req, res, next) => {
  if (err) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "ファイルサイズが大きすぎます" : err.message;
    return res.status(400).json({ error: msg });
  }
  next();
});

function getNetworkUrls(req) {
  const urls = [];
  const nics = os.networkInterfaces();
  for (const name of Object.keys(nics)) {
    for (const nic of nics[name] || []) {
      if (nic.family === "IPv4" && !nic.internal) {
        urls.push(`http://${nic.address}:${PORT}`);
      }
    }
  }
  return urls;
}

// ---------- 起動 ----------
async function main() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(THUMB_DIR, { recursive: true });
  await loadDb();
  await cleanupExpired();
  setInterval(cleanupExpired, 30 * 1000); // 30秒ごとに期限チェック

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  📂 FileShare 起動しました`);
    console.log(`     ローカル:  http://localhost:${PORT}`);
    for (const u of getNetworkUrls()) {
      console.log(`     LAN:      ${u}   ← スマホからはこちら`);
    }
    console.log("");
  });
}

main();
