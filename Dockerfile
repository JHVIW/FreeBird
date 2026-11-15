FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-slim AS run
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 TZ=Europe/Amsterdam
RUN useradd -m freebird && mkdir -p /data && chown freebird /data
COPY --from=build --chown=freebird /app ./
USER freebird
EXPOSE 3000
CMD ["sh", "-c", "npm run db:migrate && npx next start -p 3000"]
