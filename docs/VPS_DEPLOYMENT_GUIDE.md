# SKE Export Documents & Realisation Tracker
## Self-Hosted Ubuntu VPS Deployment & Local OCR Architecture Guide

---

### 1. Executive Summary & Zero-Cloud Guarantee

The SKE Export Documents & Realisation Tracker is engineered for **100% self-hosted operation** on an Ubuntu VPS.
- **Zero Cloud APIs**: No Gemini API, OpenAI API, AWS Textract, Google Cloud Vision, Firebase, or Supabase.
- **Client Zero-Footprint**: Users access the platform via any standard web browser. No user workstation requires Tesseract, Python, or Poppler installed.
- **Local VPS Extraction Engine**: Multi-tiered pipeline combining PyMuPDF (`fitz`), Poppler utilities (`pdftoppm`), OpenCV (`cv2`), and native Tesseract OCR (`pytesseract` / Tesseract.js WASM fallback).

---

### 2. OCR & PDF Processing Pipeline Architecture

```
[ User Browser ]
       │
       ▼ (HTTPS / 50MB Limit)
[ Nginx Reverse Proxy ]
       │
       ▼ (Private Network)
[ Express API Server ]
       │
       ├──► 1. Fast Path: Digital Vector PDF Check
       │         └── PyMuPDF / pdf-parse inspects text density
       │         └── If selectable characters >= 50: Direct text extraction (10-50ms)
       │
       └──► 2. Scanned / Raster Page Fallback
                 └── Poppler / PyMuPDF renders pages at 300 DPI
                 └── OpenCV: Grayscale -> Gaussian Blur -> Otsu Adaptive Thresholding
                 └── Tesseract OCR extracts text & confidence scores (1-3s)
```

#### Pipeline Stages
1. **Validation & Isolation**: Uploaded files are validated for MIME type and stored in private server storage (`storage/FY{year}/{invoiceKey}/...`). Original files are never placed in public static folders.
2. **Asynchronous Non-Blocking Execution**: Large documents are queued as background jobs (`PENDING` -> `PROCESSING` -> `COMPLETED`/`FAILED`). The Express request lifecycle returns immediately with HTTP 202 and a job tracking ID.
3. **Safe Concurrency**: VPS worker enforces `OCR_CONCURRENCY` (default: 2 parallel jobs, configurable based on CPU cores and RAM).
4. **Candidate Staging & Data Protection**: OCR results are saved in the `ocrJobs` staging table separately from verified financial records. **Unapproved OCR data never overwrites verified ledger records**.
5. **Admin Review & Approval**: Admins review candidate values side-by-side with original document previews, edit values in form inputs, and click "Approve & Commit to Ledger".

---

### 3. Ubuntu VPS Automated Deployment Instructions

#### Prerequisites
- Fresh Ubuntu 22.04 LTS or 24.04 LTS VPS (Minimum 2GB RAM, 2 vCPU recommended).
- Root or `sudo` shell access.
- Registered domain name pointing (A Record) to your VPS IP address (e.g., `exports.skenterprises.com`).

#### Step 1: Clone Repository onto the VPS
```bash
git clone https://github.com/Kottaikaruppaiya/SKE.git /opt/ske-applet
cd /opt/ske-applet
```

#### Step 2: Run the Automated VPS Provisioning Script
The automated setup script installs Docker, Docker Compose, UFW firewall rules, native Tesseract OCR, Poppler, Python 3, generates secure credentials, sets up automated nightly backups, and launches containers:
```bash
sudo chmod +x deploy/vps_setup.sh
sudo ./deploy/vps_setup.sh
```

#### Step 3: Configure Let's Encrypt SSL (Production HTTPS)
To obtain an official Let's Encrypt SSL certificate for your domain:
```bash
# 1. Stop temporary Nginx
docker compose stop nginx

# 2. Run Certbot
certbot certonly --standalone -d your-domain.com --agree-tos -m admin@your-domain.com

# 3. Symlink certificates into deployment directory
mkdir -p deploy/ssl/live
cp /etc/letsencrypt/live/your-domain.com/fullchain.pem deploy/ssl/live/
cp /etc/letsencrypt/live/your-domain.com/privkey.pem deploy/ssl/live/

# 4. Restart Nginx
docker compose up -d nginx
```

---

### 4. Background Job Queue & API Reference

| Endpoint | Method | Auth | Role | Purpose |
| :--- | :---: | :---: | :---: | :--- |
| `/api/ocr/jobs` | `GET` | Bearer | All | List background OCR jobs with status & concurrency |
| `/api/ocr/jobs/:id` | `GET` | Bearer | All | Retrieve candidate extracted fields for a job |
| `/api/ocr/jobs` | `POST` | Bearer | Admin | Enqueue file for asynchronous background OCR |
| `/api/ocr/jobs/:id/retry` | `POST` | Bearer | Admin | Retry failed extraction |
| `/api/ocr/jobs/:id/approve` | `POST` | Bearer | Admin | Commit reviewed candidate values to PostgreSQL |
| `/api/ocr/jobs/:id` | `DELETE` | Bearer | Admin | Dismiss or delete OCR job |
| `/api/documents/:id/download` | `GET` | Bearer | All | Stream original file with audit log |

---

### 5. Automated Backup & Disaster Recovery

- **Nightly Backup Job**: Configured in `/etc/cron.d/ske-backup` running at `02:00 AM`.
- **Target Location**: `/var/backups/ske/YYYYMMDD_HHMMSS/`
- **Contents**:
  - `postgres_ske_export_db_*.dump`: Compressed PostgreSQL binary database dump.
  - `storage_archive_*.tar.gz`: Gzip archive of all stored statutory documents.
  - `SHA256SUMS.txt`: Checksum manifest for cryptographic integrity.
- **Retention**: Automatic 14-day pruning.

To trigger an on-demand manual backup at any time:
```bash
sudo /opt/ske-applet/deploy/backup_storage.sh
```

To restore from a backup:
```bash
# 1. Restore Database
docker compose exec -T postgres pg_restore -U ske_user -d ske_export_db --clean < /var/backups/ske/<TIMESTAMP>/postgres_*.dump

# 2. Restore Physical Documents
tar -xzf /var/backups/ske/<TIMESTAMP>/storage_archive_*.tar.gz -C /
```
