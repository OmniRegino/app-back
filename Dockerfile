# ---------- Build Stage ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npm run build


# ---------- Production Stage ----------
FROM node:20-alpine

WORKDIR /app

# Only install production deps
COPY package*.json ./
RUN npm install --omit=dev

# Copy built files
COPY --from=builder /app/dist ./dist

# Environment
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/index.js"]