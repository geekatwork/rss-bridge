FROM node:26-alpine AS build

WORKDIR /app

COPY packages/feed-generator/package.json ./
RUN npm install

COPY packages/feed-generator/tsconfig.json ./
COPY packages/feed-generator/src/ ./src/
RUN npx tsc

FROM node:26-alpine

WORKDIR /app

COPY packages/feed-generator/package.json ./
RUN npm install --omit=dev
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=build /app/dist ./dist

EXPOSE 80

CMD ["node", "dist/index.js"]
