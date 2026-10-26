ARG BASE_IMAGE=node:22.22.0-bookworm-slim
FROM ${BASE_IMAGE}

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY . .

# Game files are prepared at build time. If the repository carries archive/ and cdn-backup/
# (the private backup) nothing is downloaded, otherwise the installer comes from the
# Internet Archive and the languages from Goodgame's CDN. Languages live outside the data
# volume so they ship with the image.
ENV LANG_DIR=/app/languages
RUN set -e; \
    FROM=""; [ -f archive/GoodgameGangster_installer.exe ] && FROM="--from archive/GoodgameGangster_installer.exe"; \
    node tools/setup.js $FROM --mirror cdn-backup --lang-dir /app/languages; \
    node tools/precompress.js; \
    rm -rf archive cdn-backup

# Web only: the browser connects through the WebSocket on the HTTP port.
ENV PORT=8882 \
    TCP_PORT=0 \
    DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8882

CMD ["node", "server/index.js"]
