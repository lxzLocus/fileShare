import express from "express";
import multer from "multer";
import QRCode from "qrcode";
import http from "node:http";
import https from "node:https";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// HTTPS化（LAN内の他端末でもクリップボードAPIを使うにはセキュアコンテキストが必要）
const USE_HTTPS = /^(1|true|yes|on)$/i.test(process.env.HTTPS || "");
// スマホ等から到達可能な公開URL/ホスト/ポート（コンテナ運用で必須になりがち）。
// コンテナ内の os.networkInterfaces() はゲストIP(例: 172.x)を返し、
// ポートも内部PORTになるため、そのままではQRがスマホから開けない。
// PUBLIC_URL:  完全なオリジンを直接指定 (例: https://share.example.com)
// PUBLIC_HOST: ホストのLAN IP/ホスト名   (例: 192.168.1.50)
// PUBLIC_PORT: 公開ポート（ポートマッピング時のホスト側。例: 3030）
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
const PUBLIC_HOST = (process.env.PUBLIC_HOST || "").trim();
const PUBLIC_PORT = process.env.PUBLIC_PORT || PORT;
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

// テキストとして「その場で開ける」か（mime または拡張子で判定）
const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "log", "csv", "tsv", "json", "xml", "yml", "yaml",
  "ini", "conf", "cfg", "toml", "env", "js", "mjs", "cjs", "ts", "jsx", "tsx",
  "css", "scss", "html", "htm", "sh", "bash", "py", "rb", "go", "rs", "java",
  "c", "h", "cpp", "sql", "php", "pl",
]);
function isTextual(f) {
  const mime = f.mime || "";
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|xml|javascript|x-sh|x-yaml|yaml)/.test(mime)) return true;
  const ext = (f.name.split(".").pop() || "").toLowerCase();
  return TEXT_EXTS.has(ext);
}

// この上限までは「その場で開く」を許可（大きすぎる場合はダウンロードのみ）
const TEXT_PREVIEW_MAX = 1024 * 1024; // 1MB

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
    // テキストとして開ける（表示・コピー可）。大きすぎるものは対象外
    isText: isTextual(f) && f.size <= TEXT_PREVIEW_MAX,
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

// スマホ等から到達可能なアクセスURLの候補を優先度順で返す。
// 1) PUBLIC_URL/PUBLIC_HOST（明示指定）→ 2) リクエストのHostヘッダ（管理者が
//    いま到達できているURL＝公開ポート込みで確実）→ 3) NICのIP（最終手段）。
// ※ コンテナ内の 3) はゲストIP/内部ポートになりスマホから届かないことが多い。
function getNetworkUrls(req) {
  const urls = [];
  const seen = new Set();
  const add = (u) => {
    if (u && !seen.has(u)) {
      seen.add(u);
      urls.push(u);
    }
  };
  // リバースプロキシ経由も考慮しつつ、基本は本サーバのスキームに従う
  const fwdProto = req?.headers["x-forwarded-proto"];
  const proto = (typeof fwdProto === "string" ? fwdProto.split(",")[0].trim() : "") ||
    (USE_HTTPS ? "https" : "http");

  // 1) 明示指定（コンテナ運用ではこれが最も確実）
  if (PUBLIC_URL) add(PUBLIC_URL);
  if (PUBLIC_HOST) add(`${proto}://${PUBLIC_HOST}:${PUBLIC_PORT}`);

  // 2) リクエストのHostヘッダ（管理者が実際にアクセスしているホスト:ポート）
  const host = req?.headers["x-forwarded-host"] || req?.headers.host;
  if (host && !/^(localhost|127\.|\[?::1\]?)/i.test(host)) {
    add(`${proto}://${host}`);
  }

  // 3) NICのIP（最終手段。コンテナ内ではゲストIP＝スマホから到達不可のことが多い）
  const nics = os.networkInterfaces();
  for (const name of Object.keys(nics)) {
    for (const nic of nics[name] || []) {
      if (nic.family === "IPv4" && !nic.internal) {
        add(`${USE_HTTPS ? "https" : "http"}://${nic.address}:${PUBLIC_PORT}`);
      }
    }
  }
  return urls;
}

// TLS証明書を用意する（TLS_KEY/TLS_CERT指定があれば優先。無ければ自己署名を生成してDATA_DIRに保存）
async function loadTlsOptions() {
  const keyPath = process.env.TLS_KEY || path.join(DATA_DIR, "tls", "key.pem");
  const certPath = process.env.TLS_CERT || path.join(DATA_DIR, "tls", "cert.pem");
  try {
    const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
    console.log(`TLS: 既存の証明書を使用 (${certPath})`);
    return { key, cert };
  } catch {
    // 無ければ自己署名を生成
  }
  if (process.env.TLS_KEY || process.env.TLS_CERT) {
    throw new Error(`TLS_KEY/TLS_CERT が指定されましたが読み込めません: ${keyPath} / ${certPath}`);
  }
  const { default: selfsigned } = await import("selfsigned");
  // 検出したLAN IPをSAN(subjectAltName)に含め、各端末が https://<IP> で開けるようにする
  const ips = [];
  const nics = os.networkInterfaces();
  for (const list of Object.values(nics)) {
    for (const nic of list || []) {
      if (nic.family === "IPv4" && !nic.internal) ips.push(nic.address);
    }
  }
  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  const pems = selfsigned.generate([{ name: "commonName", value: "fileshare.local" }], {
    days: 3650,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames }],
  });
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  await fs.writeFile(keyPath, pems.private, { mode: 0o600 });
  await fs.writeFile(certPath, pems.cert);
  console.log(`TLS: 自己署名証明書を生成しました (${certPath})`);
  return { key: pems.private, cert: pems.cert };
}

// ---------- 起動 ----------
async function main() {
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.mkdir(THUMB_DIR, { recursive: true });
  await loadDb();
  await cleanupExpired();
  setInterval(cleanupExpired, 30 * 1000); // 30秒ごとに期限チェック

  const proto = USE_HTTPS ? "https" : "http";
  const server = USE_HTTPS
    ? https.createServer(await loadTlsOptions(), app)
    : http.createServer(app);

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`\n  📂 FileShare 起動しました`);
    console.log(`     ローカル:  ${proto}://localhost:${PORT}`);
    for (const u of getNetworkUrls()) {
      console.log(`     LAN:      ${u}   ← スマホからはこちら`);
    }
    if (USE_HTTPS) {
      console.log(`\n  🔒 HTTPS有効: 自己署名証明書のため、各端末で初回に警告を許可してください`);
    }
    console.log("");
  });
}

main();
