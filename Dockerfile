# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
 && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY categories.json numbers-map.json ./

CMD ["node", "dist/main.js"]
