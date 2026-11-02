#!/usr/bin/env bash
# Automated Backup Script for SKE Export Documents & Realisation Tracker
# Backs up PostgreSQL database dump + storage/ directory (PDFs & documents)

set -euo pipefail

BACKUP_ROOT="/var/backups/ske"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_DIR="${BACKUP_ROOT}/${TIMESTAMP}"
RETENTION_DAYS=14

mkdir -p "${BACKUP_DIR}"

echo "=== [SKE BACKUP START: ${TIMESTAMP}] ==="

# 1. Backup PostgreSQL database from running container
echo "Dumping PostgreSQL database..."
docker compose exec -T postgres pg_dump -U ske_user -d ske_export_db -F c -b -v -f /tmp/ske_backup.dump
docker compose cp postgres:/tmp/ske_backup.dump "${BACKUP_DIR}/postgres_ske_export_db_${TIMESTAMP}.dump"
docker compose exec -T postgres rm /tmp/ske_backup.dump

# 2. Backup storage/ directory (PDF files and audit attachments)
echo "Archiving document storage files..."
if [ -d "/app/storage" ]; then
    tar -czf "${BACKUP_DIR}/storage_archive_${TIMESTAMP}.tar.gz" -C /app storage
elif docker volume inspect applet_ske_storage >/dev/null 2>&1; then
    docker run --rm -v applet_ske_storage:/storage -v "${BACKUP_DIR}":/backup alpine tar -czf "/backup/storage_archive_${TIMESTAMP}.tar.gz" -C / storage
fi

# 3. Create checksum manifest
echo "Generating SHA256 checksums..."
cd "${BACKUP_DIR}"
sha256sum * > SHA256SUMS.txt

# 4. Clean up backups older than RETENTION_DAYS
echo "Pruning backups older than ${RETENTION_DAYS} days..."
find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d -mtime +${RETENTION_DAYS} -exec rm -rf {} +

echo "=== [SKE BACKUP COMPLETED: ${BACKUP_DIR}] ==="
