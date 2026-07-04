# Multi-stage build process for the reverse proxy application
# Stage 1: Build stage - Initialized to capture and compile under Jenkins CI
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

FROM node:20-alpine

WORKDIR /app

COPY package*.json ./

RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

COPY config.yaml ./
EXPOSE 8080 8443

CMD ["node", "dist/index.js", "--config", "config.yaml"]
