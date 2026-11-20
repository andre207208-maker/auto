# Multi-stage production Dockerfile optimized for Google Cloud Run
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies cleanly
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# Copy TypeScript config and source
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript to dist/
RUN npm run build

# Prune devDependencies for smaller runtime image
RUN npm prune --omit=dev

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Run as non-root user for Cloud Run security best practices
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN chown -R appuser:appgroup /app
USER appuser

EXPOSE 8080

CMD ["node", "dist/server.js"]
