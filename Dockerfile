# syntax=docker/dockerfile:1

# ============================================================
# wacrm — production image for EasyPanel (or any Docker host).
#
# Three stages so the final image only ships the Next.js
# "standalone" trace output (see next.config.ts `output`),
# not the full node_modules / build cache.
# ============================================================

ARG NODE_VERSION=20-alpine

# ---- deps: install dependencies with a cached, reproducible install ----
FROM node:${NODE_VERSION} AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ---- builder: compile the Next.js app ----
FROM node:${NODE_VERSION} AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build-time env vars: NEXT_PUBLIC_* values are inlined into the client
# bundle at this step, so EasyPanel must pass them as build args if you
# rely on the public site URL / Supabase URL at build time. Server-only
# secrets (SUPABASE_SERVICE_ROLE_KEY, ENCRYPTION_KEY, META_APP_SECRET,
# etc.) are NOT needed at build time — only at runtime.
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}

ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal production image ----
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone output already includes a minimal node_modules + server.js.
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs

EXPOSE 3000

CMD ["node", "server.js"]
