/**
 * IPC Relay — unit tests.
 *
 * Tests IpcRelay configuration, frame building, status reporting,
 * and relay registry operations. Network I/O is not exercised
 * (no real sockets).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  IpcRelay,
  getOrCreateRelay,
  removeRelay,
  getRelayStatus,
  listRelays,
} from '@native/ipc/IpcRelay';

describe('IpcRelay', () => {
  describe('status', () => {
    it('reports sessionId and connected=false initially', () => {
      const relay = new IpcRelay({ sessionId: 'test-1' });
      const status = relay.status;
      expect(status.sessionId).toBe('test-1');
      expect(status.connected).toBe(false);
      expect(status.messagesSent).toBe(0);
      expect(status.messagesReceived).toBe(0);
    });

    it('reports correct transport for Windows', () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const relay = new IpcRelay({ sessionId: 'test-1' });
        expect(relay.status.transport).toBe('named-pipe');
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
    });

    it('reports correct transport for Linux', () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      try {
        const relay = new IpcRelay({ sessionId: 'test-1' });
        expect(relay.status.transport).toBe('unix-socket');
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
    });
  });

  describe('path resolution', () => {
    it('resolves to a custom path when config.path is set', () => {
      const relay = new IpcRelay({
        sessionId: 'test-1',
        path: '/custom/path.sock',
      });
      expect(relay.status.path).toBe('/custom/path.sock');
    });

    it('resolves default named pipe path on Windows', () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const relay = new IpcRelay({ sessionId: 'abc-123' });
        expect(relay.status.path).toContain('jshookmcp_emu_abc-123');
        expect(relay.status.path).toContain('pipe');
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
    });

    it('resolves default Unix socket path on Linux', () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
      try {
        const relay = new IpcRelay({ sessionId: 'def-456' });
        expect(relay.status.path).toBe('/tmp/jshookmcp_emu_def-456.sock');
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
    });
  });

  describe('registry', () => {
    beforeEach(() => {
      // Clean up any leftover relays
      for (const s of listRelays()) {
        removeRelay(s.sessionId);
      }
    });

    it('getOrCreateRelay returns the same instance for same sessionId', () => {
      const r1 = getOrCreateRelay({ sessionId: 'registry-test' });
      const r2 = getOrCreateRelay({ sessionId: 'registry-test' });
      expect(r1).toBe(r2);
    });

    it('getOrCreateRelay returns different instances for different sessionIds', () => {
      const r1 = getOrCreateRelay({ sessionId: 'sess-a' });
      const r2 = getOrCreateRelay({ sessionId: 'sess-b' });
      expect(r1).not.toBe(r2);
    });

    it('removeRelay disconnects and removes from registry', () => {
      getOrCreateRelay({ sessionId: 'to-remove' });
      expect(removeRelay('to-remove')).toBe(true);
      expect(getRelayStatus('to-remove')).toBeNull();
    });

    it('removeRelay returns false for unknown sessionId', () => {
      expect(removeRelay('no-such')).toBe(false);
    });

    it('getRelayStatus returns null for unknown sessionId', () => {
      expect(getRelayStatus('no-such')).toBeNull();
    });

    it('listRelays returns all active relays', () => {
      getOrCreateRelay({ sessionId: 'list-a' });
      getOrCreateRelay({ sessionId: 'list-b' });
      const relays = listRelays();
      expect(relays.length).toBe(2);
      const ids = relays.map((r) => r.sessionId);
      expect(ids).toContain('list-a');
      expect(ids).toContain('list-b');
    });
  });

  describe('disconnect', () => {
    it('transitions connected to false and emits disconnected event', () => {
      const relay = new IpcRelay({ sessionId: 'disc-test' });
      let emitted = false;
      relay.on('disconnected', () => {
        emitted = true;
      });
      relay.disconnect();
      expect(relay.status.connected).toBe(false);
      expect(emitted).toBe(true);
    });
  });
});
