# build stage : praveen - i am intialising it so that to capture under jenkins
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# runtime stage
FROM node:20-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY config.yaml ./
# COPY key.pem cert.pem ./

EXPOSE 8080 8443

CMD ["node", "dist/index.js", "--config", "config.yaml"]
