# Multi-stage production Dockerfile for SKE Export Documents & Realisation Tracker
# Self-hosted on Ubuntu VPS with native Tesseract OCR, PyMuPDF, Poppler & OpenCV

# --- Stage 1: Build Frontend Assets ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# --- Stage 2: Production Runtime with Local OCR & Python Pipeline ---
FROM node:22-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV OCR_CONCURRENCY=2

# Install native OCR, PDF manipulation and OpenCV dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    tesseract-ocr \
    tesseract-ocr-eng \
    poppler-utils \
    libgl1 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Python OCR modules (PyMuPDF, pytesseract, opencv, pillow, pdf2image)
RUN pip3 install --no-cache-dir --break-system-packages \
    pymupdf \
    pytesseract \
    opencv-python-headless \
    pdf2image \
    pillow

# Copy dependency manifests and install production node dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm install -g tsx

# Copy built frontend assets and server application code
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/server ./server
COPY --from=builder /app/server.ts ./server.ts
COPY --from=builder /app/src/types ./src/types
COPY --from=builder /app/public ./public

# Prepare persistent storage directories
RUN mkdir -p /app/storage/data /app/storage/staging

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["tsx", "server.ts"]
