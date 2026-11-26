FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci --no-audit --no-fund && npm run build

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache docker-cli docker-cli-compose
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
ENV NODE_ENV=production \
    DATA_DIR=/app/data \
    STACKS_DIR=/opt/stacks \
    WEB_DIST=/app/packages/web/dist
VOLUME ["/app/data", "/opt/stacks"]
EXPOSE 5001
CMD ["node", "packages/server/dist/index.js"]
