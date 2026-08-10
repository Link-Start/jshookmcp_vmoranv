/**
 * Disk-Based Scan Persistence — CrySearch / CE parity.
 *
 * When memory_first_scan is called with persistToDisk=true, scan results are
 * streamed to a temporary binary file instead of held entirely in memory.
 * This enables scans with millions of addresses without exhausting RAM.
 *
 * File format: contiguous [8-byte LE address][8-byte LE value] records.
 * Each record is 16 bytes. A 100M-address scan produces a ~1.6 GB file.
 *
 * Limits:
 * - Maximum 100 million addresses (~1.6 GB file)
 * - Above that, the scan is rejected with "narrow first" guidance
 *
 * The persisted file is referenced by a sessionId and can be used as input
 * to memory_next_scan, which reads from disk instead of in-memory session.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

/** Maximum addresses when persisting to disk (100M). */
export const MAX_DISK_SCAN_ADDRESSES = 100_000_000;

/** Bytes per record: 8-byte address (LE) + 8-byte value (LE) = 16 bytes. */
export const DISK_RECORD_SIZE = 16;

/** Estimated max file size: 100M × 16 = ~1.6 GB. */
export const MAX_DISK_SCAN_FILE_SIZE = MAX_DISK_SCAN_ADDRESSES * DISK_RECORD_SIZE;

export interface DiskScanSession {
  sessionId: string;
  filePath: string;
  totalRecords: number;
  valueType: string;
}

/** In-memory registry of active disk scan sessions. */
const diskSessions = new Map<string, DiskScanSession>();

/**
 * Create a new disk-backed scan session.
 * Returns a session object. The file is created and opened for writing.
 */
export function createDiskScanSession(
  sessionId: string,
  valueType: string,
  tmpDir?: string,
): DiskScanSession {
  const dir = tmpDir ?? os.tmpdir();
  const fileName = `jshook-scan-${sessionId.replace(/[^a-zA-Z0-9\-_]/g, '_')}.bin`;
  const filePath = path.join(dir, fileName);

  // Create the file (truncate if exists)
  fs.writeFileSync(filePath, Buffer.alloc(0));

  const session: DiskScanSession = {
    sessionId,
    filePath,
    totalRecords: 0,
    valueType,
  };

  diskSessions.set(sessionId, session);
  return session;
}

/**
 * Append address-value pairs to a disk scan session's backing file.
 * Uses streaming append for efficiency.
 */
export function appendToDiskScan(
  sessionId: string,
  records: Array<{ address: bigint; value: bigint }>,
): void {
  const session = diskSessions.get(sessionId);
  if (!session) {
    throw new Error(`Disk scan session "${sessionId}" not found`);
  }

  const newTotal = session.totalRecords + records.length;
  if (newTotal > MAX_DISK_SCAN_ADDRESSES) {
    throw new Error(
      `Disk scan session "${sessionId}" would exceed ${MAX_DISK_SCAN_ADDRESSES} addresses ` +
        `(${newTotal.toLocaleString()}). Narrow the scan before persisting to disk.`,
    );
  }

  // Build a buffer of all records
  const buf = Buffer.allocUnsafe(records.length * DISK_RECORD_SIZE);
  for (let i = 0; i < records.length; i += 1) {
    const offset = i * DISK_RECORD_SIZE;
    const rec = records[i]!;
    buf.writeBigUInt64LE(rec.address, offset);
    buf.writeBigUInt64LE(rec.value, offset + 8);
  }

  // Append to file
  fs.appendFileSync(session.filePath, buf);
  session.totalRecords = newTotal;
}

/**
 * Read all addresses from a persisted disk scan file.
 * Returns address array — for next_scan to filter.
 *
 * NOTE: This loads ALL addresses into memory for the filtering pass.
 * For extremely large scans, this is the tradeoff — addresses must be in
 * memory for the comparator loop. The initial scan result (which might have
 * been 100M+) was streamed to disk to avoid OOM during collection, but
 * next_scan needs to read them back for comparison.
 *
 * In practice, next_scan typically runs after the result set has already been
 * narrowed by one or more filter passes.
 */
export function readAllFromDiskScan(sessionId: string): string[] {
  const session = diskSessions.get(sessionId);
  if (!session) {
    throw new Error(`Disk scan session "${sessionId}" not found`);
  }

  const fd = fs.openSync(session.filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const recordCount = Math.floor(stat.size / DISK_RECORD_SIZE);
    const buf = Buffer.alloc(stat.size);
    fs.readSync(fd, buf, 0, stat.size, 0);

    const addresses: string[] = [];
    for (let i = 0; i < recordCount; i += 1) {
      const offset = i * DISK_RECORD_SIZE;
      const addr = buf.readBigUInt64LE(offset);
      addresses.push(`0x${addr.toString(16).toUpperCase()}`);
    }
    return addresses;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Get disk scan session info.
 */
export function getDiskScanSession(sessionId: string): DiskScanSession | undefined {
  return diskSessions.get(sessionId);
}

/**
 * Delete a disk scan session and its backing file.
 */
export function deleteDiskScanSession(sessionId: string): boolean {
  const session = diskSessions.get(sessionId);
  if (!session) return false;

  try {
    if (fs.existsSync(session.filePath)) {
      fs.unlinkSync(session.filePath);
    }
  } catch {
    // Best-effort cleanup
  }

  diskSessions.delete(sessionId);
  return true;
}

/**
 * Get total file size in bytes for a disk scan session.
 */
export function getDiskScanFileSize(sessionId: string): number {
  const session = diskSessions.get(sessionId);
  if (!session) return 0;

  try {
    return fs.statSync(session.filePath).size;
  } catch {
    return 0;
  }
}

/**
 * List all active disk scan sessions.
 */
export function listDiskScanSessions(): DiskScanSession[] {
  return [...diskSessions.values()];
}
