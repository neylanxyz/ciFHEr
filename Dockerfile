# ── Stage 1: Build fhe-sidecar (Rust) ────────────────────────────────────────
FROM rust:1.89-slim AS sidecar-builder

RUN apt-get update && apt-get install -y pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /build/fhe-sidecar
COPY fhe-sidecar/Cargo.toml fhe-sidecar/Cargo.lock ./
COPY fhe-sidecar/src ./src

RUN cargo build --release

# ── Stage 2: Build worker (Node.js / TypeScript) ──────────────────────────────
FROM node:24-slim AS worker-builder

WORKDIR /build/worker
COPY worker/package.json worker/yarn.lock* worker/package-lock.json* ./
RUN npm install

COPY worker/tsconfig.json ./
COPY worker/src ./src
RUN npm run build

# ── Stage 3: Runtime ──────────────────────────────────────────────────────────
FROM node:24-slim

RUN apt-get update && apt-get install -y libssl3 ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy compiled sidecar binary
COPY --from=sidecar-builder /build/fhe-sidecar/target/release/fhe-sidecar ./fhe-sidecar/target/release/fhe-sidecar

# Copy worker dist + node_modules
COPY --from=worker-builder /build/worker/dist ./worker/dist
COPY --from=worker-builder /build/worker/node_modules ./worker/node_modules
COPY worker/package.json ./worker/

# Copy IDLs (needed at runtime by the worker)
COPY worker/src/idl ./worker/dist/idl

# Write worker keypair from env var at container startup, then launch worker
CMD sh -c '\
  mkdir -p /app/fhe-sidecar/.fhe-keys && \
  echo "$WORKER_KEYPAIR_JSON" > /tmp/worker-keypair.json && \
  WORKER_KEYPAIR_PATH=/tmp/worker-keypair.json \
  node /app/worker/dist/index.js'
