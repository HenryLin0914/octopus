FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA DATA_DIR=/data PORT=8787 TZ=Asia/Taipei NODE_NO_WARNINGS=1
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8787/api/health || exit 1
CMD ["node", "server/server.js"]
