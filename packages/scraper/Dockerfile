FROM node:26-alpine AS dependencies

WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true

COPY package.json package-lock.json ./
COPY packages/scraper/package.json ./packages/scraper/
COPY packages/feed-generator/package.json ./packages/feed-generator/

FROM dependencies AS build
RUN npm ci --workspace=packages/scraper
COPY packages/scraper/tsconfig.json ./packages/scraper/
COPY packages/scraper/src/ ./packages/scraper/src/
RUN npm run --workspace=packages/scraper build

FROM dependencies AS production-dependencies
RUN npm ci --workspace=packages/scraper --omit=dev --omit=optional

FROM node:26-alpine

RUN apk add --no-cache chromium nss freetype harfbuzz ca-certificates ttf-freefont

RUN addgroup -g 10001 -S appgroup \
	&& adduser -S -D -u 10001 -G appgroup appuser \
	&& mkdir -p /home/appuser/.cache \
	&& chown appuser:appgroup /home/appuser/.cache

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV HOME=/home/appuser

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

COPY --from=production-dependencies /app /app
COPY --from=build /app/packages/scraper/dist /app/packages/scraper/dist

WORKDIR /app/packages/scraper
USER appuser

CMD ["node", "dist/index.js"]
