FROM oven/bun:1

WORKDIR /app

# Install build tools for native modules
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files first for better caching
COPY package.json bun.lock* ./
COPY server/package.json ./server/
COPY client/package.json ./client/
COPY shared/package.json ./shared/

# Install dependencies
RUN bun install

# Copy source code
COPY . .

# Build server
WORKDIR /app/server
RUN bun run build

# Build client
WORKDIR /app/client
RUN bun run build

# Back to app root
WORKDIR /app

ENV PORT=7860
ENV NODE_ENV=production

EXPOSE 7860

CMD ["bun", "server/dist/server.js"]
