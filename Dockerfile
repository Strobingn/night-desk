FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY . .
RUN npm run build:web && npm run build:server
ENV LIVE_TRADING=false \
    DEMO_FEED=1 \
    FEED_MODE=auto \
    PORT=4721 \
    HOST=0.0.0.0 \
    DB_PATH=/data/desk.sqlite \
    LOG_JSONL=/data/desk.jsonl
EXPOSE 4721
CMD ["node", "dist/index.js"]
