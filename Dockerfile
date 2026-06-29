# ---- build & runtime（依存が軽いので単一ステージ） ----
FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 動画サムネ用に musl ネイティブの ffmpeg を入れる（同梱ffmpeg-staticは使わない）
RUN apk add --no-cache ffmpeg

# 依存だけ先に入れてレイヤキャッシュを効かせる
# --omit=dev だけにする(=devのffmpeg-staticは入らない)。
# sharpのネイティブバイナリは sharp 自身の optionalDependencies なので optional は除外しない
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

# アプリ本体
COPY server.js ./
COPY public ./public

# アップロード/DBの保存先（compose でボリュームをマウント）
ENV DATA_DIR=/app/data
# 動画サムネはシステムの ffmpeg を使う
ENV FFMPEG_PATH=ffmpeg
RUN mkdir -p /app/data/uploads && \
    addgroup -S app && adduser -S app -G app && \
    chown -R app:app /app
USER app

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
