import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  createDiskScanSession,
  appendToDiskScan,
  readAllFromDiskScan,
  deleteDiskScanSession,
  getDiskScanSession,
  getDiskScanFileSize,
  listDiskScanSessions,
  DISK_RECORD_SIZE,
} from '../../../../../src/server/domains/memory/handlers/scan-persistence';

describe('Disk Scan Persistence', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-persist-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe('createDiskScanSession', () => {
    it('creates a session and empty backing file', () => {
      const session = createDiskScanSession('test-s1', 'int32', tmpDir);
      expect(session.sessionId).toBe('test-s1');
      expect(session.valueType).toBe('int32');
      expect(session.totalRecords).toBe(0);
      expect(fs.existsSync(session.filePath)).toBe(true);
      expect(fs.statSync(session.filePath).size).toBe(0);
    });

    it('session is retrievable via getDiskScanSession', () => {
      createDiskScanSession('test-s2', 'float', tmpDir);
      const retrieved = getDiskScanSession('test-s2');
      expect(retrieved).toBeDefined();
      expect(retrieved!.valueType).toBe('float');
    });
  });

  describe('appendToDiskScan', () => {
    it('appends records and updates totalRecords', () => {
      createDiskScanSession('test-s3', 'int32', tmpDir);

      appendToDiskScan('test-s3', [
        { address: BigInt('0x7FF612340000'), value: BigInt(100) },
        { address: BigInt('0x7FF612340010'), value: BigInt(200) },
        { address: BigInt('0x7FF612340020'), value: BigInt(300) },
      ]);

      const updated = getDiskScanSession('test-s3')!;
      expect(updated.totalRecords).toBe(3);

      // File size should be 3 * 16 = 48 bytes
      const size = getDiskScanFileSize('test-s3');
      expect(size).toBe(3 * DISK_RECORD_SIZE);
    });

    it('correctly writes binary LE addresses and values', () => {
      createDiskScanSession('test-s4', 'int64', tmpDir);
      appendToDiskScan('test-s4', [
        { address: BigInt('0xABCD'), value: BigInt('0x1234567890ABCDEF') },
      ]);

      const session = getDiskScanSession('test-s4')!;
      const buf = fs.readFileSync(session.filePath);
      expect(buf.length).toBe(DISK_RECORD_SIZE);

      // First 8 bytes: address 0xABCD in LE
      const addr = buf.readBigUInt64LE(0);
      expect(addr).toBe(BigInt('0xABCD'));

      // Next 8 bytes: value
      const val = buf.readBigUInt64LE(8);
      expect(val).toBe(BigInt('0x1234567890ABCDEF'));
    });

    it('rejects when totalRecords would exceed the cap', () => {
      // Create session and set totalRecords near the limit to verify the guard
      const session = createDiskScanSession('test-s5', 'byte', tmpDir);

      // Directly set totalRecords to simulate near-cap state
      // (we can't create 100M entries in-memory without OOM)
      const recordsToSimulate = 99_999_999; // 1 below max
      const buf = Buffer.alloc(DISK_RECORD_SIZE);
      buf.writeBigUInt64LE(BigInt(0), 0);
      buf.writeBigUInt64LE(BigInt(0), 8);
      // Write placeholder data and set the counter
      const batch = 1000;
      for (let i = 0; i < Math.min(batch, recordsToSimulate); i += 1) {
        fs.appendFileSync(session.filePath, buf);
      }
      // Set the in-memory counter
      (session as unknown as Record<string, unknown>).totalRecords = recordsToSimulate;

      // Adding 2 records would push it over the limit
      expect(() =>
        appendToDiskScan('test-s5', [
          { address: BigInt(1), value: BigInt(1) },
          { address: BigInt(2), value: BigInt(2) },
        ]),
      ).toThrow(/exceed/);
    });

    it('throws for unknown session', () => {
      expect(() =>
        appendToDiskScan('nonexistent', [{ address: BigInt(0), value: BigInt(0) }]),
      ).toThrow('not found');
    });
  });

  describe('readAllFromDiskScan', () => {
    it('reads back all addresses in order', () => {
      createDiskScanSession('test-s6', 'int32', tmpDir);
      appendToDiskScan('test-s6', [
        { address: BigInt('0x1000'), value: BigInt(10) },
        { address: BigInt('0x2000'), value: BigInt(20) },
        { address: BigInt('0x3000'), value: BigInt(30) },
      ]);

      const addresses = readAllFromDiskScan('test-s6');
      expect(addresses).toEqual(['0x1000', '0x2000', '0x3000']);
    });

    it('handles empty session (zero records)', () => {
      createDiskScanSession('test-s7', 'float', tmpDir);

      const addresses = readAllFromDiskScan('test-s7');
      expect(addresses).toEqual([]);
    });

    it('throws for unknown session', () => {
      expect(() => readAllFromDiskScan('no-such-session')).toThrow('not found');
    });
  });

  describe('deleteDiskScanSession', () => {
    it('deletes the session and its backing file', () => {
      const session = createDiskScanSession('test-s8', 'int32', tmpDir);
      expect(fs.existsSync(session.filePath)).toBe(true);

      const deleted = deleteDiskScanSession('test-s8');
      expect(deleted).toBe(true);
      expect(fs.existsSync(session.filePath)).toBe(false);
      expect(getDiskScanSession('test-s8')).toBeUndefined();
    });

    it('returns false for non-existent session', () => {
      expect(deleteDiskScanSession('no-such')).toBe(false);
    });
  });

  describe('listDiskScanSessions', () => {
    it('lists all active sessions', () => {
      createDiskScanSession('test-s9', 'int32', tmpDir);
      createDiskScanSession('test-s10', 'float', tmpDir);

      const sessions = listDiskScanSessions();
      const ids = sessions.map((s) => s.sessionId);
      expect(ids).toContain('test-s9');
      expect(ids).toContain('test-s10');
    });
  });

  describe('getDiskScanFileSize', () => {
    it('returns 0 for non-existent session', () => {
      expect(getDiskScanFileSize('no-such')).toBe(0);
    });

    it('returns correct file size', () => {
      createDiskScanSession('test-s11', 'int32', tmpDir);
      appendToDiskScan('test-s11', [
        { address: BigInt(1), value: BigInt(2) },
        { address: BigInt(3), value: BigInt(4) },
      ]);

      expect(getDiskScanFileSize('test-s11')).toBe(2 * DISK_RECORD_SIZE);
    });
  });
});
