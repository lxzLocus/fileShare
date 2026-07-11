# 📂 FileShare

PC ↔ スマホ間でファイルをサッと受け渡すための、**登録不要・一時保管型**のファイル共有Webアプリ。
ドラッグ&ドロップでアップロード、保存期限が来たら自動削除。同じWi-FiならQRコードでスマホからすぐ開けます。

## 特長
- 🖱️ ドラッグ&ドロップでアップロード（複数同時・進捗バー付き）
- ⏱️ 保存期限を選択（10分〜30日／無期限）→ 期限切れは**自動削除**
- 🖼️ 画像・🎬動画は**サムネイル生成**（リサイズ＋webpキャッシュ）。動画は▶バッジ付き。その他はファイル種別アイコン
  - 画像は `sharp`、動画は `ffmpeg`（1秒地点のフレーム抽出）を使用。どちらも無ければアイコン表示にフォールバック
- 🔀 **サムネイル表示／リスト表示**を切替（選択は記憶）
- 📋 画像は**クリップボードにコピー**（📋コピー ボタン）。ページ上で **Ctrl+V** すれば貼り付け画像をそのままアップロード
- 📱 LANのアクセスURL一覧＋QRコード表示でスマホ転送がラク
- 🔓 ユーザ登録なし
- 🐳 Docker / docker compose 対応・GitHub Actions で自動ビルド

## ローカルで動かす
```bash
npm install
npm start
# http://localhost:3000  （別端末からは表示される http://<LAN IP>:3000 ）
```

## Docker で動かす
```bash
# ローカルビルドして起動
docker compose up --build -d
# → http://<ホストのIP>:3000
```
アップロードファイルとメタデータは `./data` に永続化されます。

### GHCR のイメージを使う（LXC等でビルド不要）
`docker-compose.yml` の `build: .` をコメントアウトし、`image:` を有効化：
```yaml
    # build: .
    image: ghcr.io/<OWNER>/fileshare:latest
```
```bash
docker compose up -d
```

## GitHub Actions（自動ビルド）
`main` への push / `v*` タグで `.github/workflows/docker.yml` が走り、
`ghcr.io/<OWNER>/fileshare` に multi-arch（amd64/arm64）イメージを push します。
PR ではビルド検証のみ。リポジトリの Actions に `packages: write` 権限が必要です（workflow に設定済み）。

## 設定（環境変数）
| 変数 | 既定値 | 説明 |
|------|--------|------|
| `PORT` | `3000` | 待ち受けポート |
| `DATA_DIR` | アプリ直下 | `uploads/` と `db.json` の保存先（Dockerでは `/app/data`） |
| `HTTPS` | `0` | `1`/`true` でHTTPS起動。証明書が無ければ自己署名を `DATA_DIR/tls/` に自動生成 |
| `TLS_KEY` / `TLS_CERT` | （自動生成） | 独自の鍵・証明書ファイルパスを使いたい場合に指定（mkcert等） |

1ファイルの上限は `server.js` の `MAX_FILE_SIZE`（既定 5GB）で変更できます。

### クリップボードとHTTPS
「📋 コピー」と **Ctrl+V 貼り付け** はブラウザの Clipboard API を使うため、**セキュアコンテキスト（`localhost` か HTTPS）でのみ動作**します。
`http://<LAN IP>:3000` のように**IP＋HTTPで別端末から開くと使えません**。その場合は `HTTPS=1` で起動してください（自己署名証明書を自動生成。各端末で初回に「安全でない接続」の警告を1回許可すれば、以降クリップボードが有効になります）。

## API
| メソッド | パス | 用途 |
|----------|------|------|
| `POST` | `/api/upload` | アップロード（field: `files`, `expires`） |
| `GET` | `/api/files` | 一覧 |
| `GET` | `/api/file/:id` | ダウンロード（添付） |
| `GET` | `/api/raw/:id` | インライン表示（原寸プレビュー） |
| `GET` | `/api/thumb/:id` | サムネイル（画像はリサイズ、それ以外は原本へ） |
| `DELETE` | `/api/file/:id` | 手動削除 |
| `GET` | `/api/info` | アクセスURL一覧 |
| `GET` | `/api/qr?url=` | QRコード（SVG） |

> ⚠️ 認証なしの一時受け渡し用です。インターネットに直接公開する場合は、リバースプロキシでのBasic認証/HTTPS化などを検討してください。
