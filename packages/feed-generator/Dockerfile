FROM node:26-alpine AS dependencies

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/scraper/package.json ./packages/scraper/
COPY packages/feed-generator/package.json ./packages/feed-generator/

FROM dependencies AS build
RUN npm ci --workspace=packages/feed-generator
COPY packages/feed-generator/tsconfig.json ./packages/feed-generator/
COPY packages/feed-generator/src/ ./packages/feed-generator/src/
RUN npm run --workspace=packages/feed-generator build

FROM dependencies AS production-dependencies
RUN npm ci --workspace=packages/feed-generator --omit=dev --omit=optional

FROM node:26-alpine

WORKDIR /app

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=production-dependencies /app /app
COPY --from=build /app/packages/feed-generator/dist /app/packages/feed-generator/dist

WORKDIR /app/packages/feed-generator

EXPOSE 80

CMD ["node", "dist/index.js"]
