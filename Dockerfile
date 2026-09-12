FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production

# 依赖先单独一层，改代码不会重装依赖。唯一两个直接依赖都是运行时依赖，没有 dev 依赖。
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY docs ./docs
COPY README.md ./

# 状态与审计落在这个卷里：容器重建不丢账本，但同一目录同时只能有一个进程。
RUN mkdir -p /data && chown -R node:node /data && chown -R node:node /app
VOLUME /data
USER node

ENV STARHALL_HOST=0.0.0.0 \
    STARHALL_PORT=4317 \
    STARHALL_DATA_DIR=/data

EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.STARHALL_PORT||4317)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
