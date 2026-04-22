# AI SEO Agent — backend + Angular UI (production)
# Single Node base so native modules (better-sqlite3) match runtime.
FROM node:20-bookworm-slim AS builder

RUN apt-get update && apt-get install -y python3 make g++ sqlite3 libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /build

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Backend deps + Playwright browser
COPY backend/package.json backend/package-lock.json* ./backend/
RUN cd backend && npm install && npx playwright install chromium

COPY backend ./backend
RUN cd backend && npm run build

# Frontend
COPY frontend/angular-dashboard/package.json frontend/angular-dashboard/package-lock.json* ./frontend/angular-dashboard/
RUN cd frontend/angular-dashboard && npm install

COPY frontend/angular-dashboard ./frontend/angular-dashboard
RUN cd frontend/angular-dashboard && npx ng build --configuration production

FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y \
  libnss3 libatk1.0-0 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
  libxfixes3 libxrandr2 libgbm1 libasound2 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=builder /ms-playwright /ms-playwright
COPY --from=builder /build/backend/package.json ./
COPY --from=builder /build/backend/node_modules ./node_modules
COPY --from=builder /build/backend/dist ./dist
COPY --from=builder /build/frontend/angular-dashboard/dist ./frontend/angular-dashboard/dist

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "dist/server.js"]
