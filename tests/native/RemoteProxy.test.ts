/**
 * RemoteProxy — WebSocket remote proxy lifecycle tests.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  RemoteProxy,
  getOrCreateRemoteProxy,
  getRemoteProxy,
  removeRemoteProxy,
  listRemoteProxies,
} from '@native/RemoteProxy';

describe('RemoteProxy config and status', () => {
  it('stores config and returns status when disconnected', () => {
    const proxy = new RemoteProxy({ url: 'ws://127.0.0.1:17171' });
    const s = proxy.status;
    expect(s.url).toBe('ws://127.0.0.1:17171');
    expect(s.connected).toBe(false);
    expect(s.bytesSent).toBe(0);
    expect(s.connectedAt).toBeNull();
  });

  it('accepts auth token and timeouts', () => {
    const proxy = new RemoteProxy({
      url: 'ws://remote:17171',
      authToken: 'mysecret',
      connectTimeoutMs: 5000,
      requestTimeoutMs: 30000,
    });
    expect(proxy.status.url).toBe('ws://remote:17171');
  });
});

describe('RemoteProxy disconnect', () => {
  it('disconnects without error when not connected', () => {
    const proxy = new RemoteProxy({ url: 'ws://127.0.0.1:17171' });
    expect(() => proxy.disconnect()).not.toThrow();
    expect(proxy.status.connected).toBe(false);
  });
});

describe('RemoteProxy registry', () => {
  afterEach(() => {
    removeRemoteProxy('test-proxy');
    removeRemoteProxy('test-proxy-2');
  });

  it('getOrCreate creates and retrieves same instance', () => {
    const p1 = getOrCreateRemoteProxy('test-proxy', { url: 'ws://127.0.0.1:17171' });
    const p2 = getOrCreateRemoteProxy('test-proxy', { url: 'ws://other:9999' });
    expect(p1).toBe(p2);
    expect(p1.status.url).toBe('ws://127.0.0.1:17171');
  });

  it('getRemoteProxy returns undefined for unknown key', () => {
    expect(getRemoteProxy('nonexistent')).toBeUndefined();
  });

  it('getRemoteProxy returns instance for known key', () => {
    getOrCreateRemoteProxy('test-proxy-2', { url: 'ws://127.0.0.1:17171' });
    expect(getRemoteProxy('test-proxy-2')).toBeDefined();
  });

  it('removeRemoteProxy disconnects and removes', () => {
    getOrCreateRemoteProxy('test-proxy', { url: 'ws://127.0.0.1:17171' });
    expect(removeRemoteProxy('test-proxy')).toBe(true);
    expect(getRemoteProxy('test-proxy')).toBeUndefined();
  });

  it('removeRemoteProxy returns false for unknown', () => {
    expect(removeRemoteProxy('nonexistent')).toBe(false);
  });

  it('listRemoteProxies returns array of statuses', () => {
    getOrCreateRemoteProxy('list-1', { url: 'ws://a:1111' });
    getOrCreateRemoteProxy('list-2', { url: 'ws://b:2222' });
    const urls = listRemoteProxies().map((s) => s.url);
    expect(urls).toContain('ws://a:1111');
    expect(urls).toContain('ws://b:2222');
    removeRemoteProxy('list-1');
    removeRemoteProxy('list-2');
  });
});
