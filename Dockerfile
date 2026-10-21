FROM node:22.23.4-slim

COPY scripts/check-system-ca.sh /usr/local/bin/check-system-ca
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && sh /usr/local/bin/check-system-ca \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy source
COPY . .

# Build
RUN npm run build

# Run
EXPOSE 3001
CMD ["node", "dist/index.js"]
