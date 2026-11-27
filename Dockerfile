FROM node:22-alpine AS build
WORKDIR /app
# node-pty 需要本地编译原生模块（提供真正的交互式终端）
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund && npm run build

FROM node:22-alpine
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ARG APP_BUILD_TIME=unknown
WORKDIR /app
RUN apk add --no-cache docker-cli docker-cli-compose
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
ENV NODE_ENV=production \
    APP_VERSION=$APP_VERSION \
    APP_COMMIT=$APP_COMMIT \
    APP_BUILD_TIME=$APP_BUILD_TIME \
    DATA_DIR=/app/data \
    STACKS_DIR=/opt/stacks \
    WEB_DIST=/app/packages/web/dist
VOLUME ["/app/data", "/opt/stacks"]
EXPOSE 5001
CMD ["node", "packages/server/dist/index.js"]
