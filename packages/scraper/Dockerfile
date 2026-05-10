FROM node:20-alpine AS build

RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

WORKDIR /app

COPY packages/scraper/package.json ./
RUN npm install

COPY packages/scraper/tsconfig.json ./
COPY packages/scraper/src/ ./src/
RUN npx tsc

FROM node:20-alpine

RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

RUN addgroup -g 10001 -S appgroup \
	&& adduser -S -D -u 10001 -G appgroup appuser \
	&& mkdir -p /home/appuser/.cache

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV HOME=/home/appuser

WORKDIR /app

COPY packages/scraper/package.json ./
RUN npm install

COPY --from=build /app/dist ./dist

RUN chown -R appuser:appgroup /app /home/appuser

USER appuser

CMD ["node", "dist/index.js"]
