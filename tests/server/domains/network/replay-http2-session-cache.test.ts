/**
 * HTTP/2 session cache reuse in network_replay_request.
 *
 * r1-2: replays to the same origin should reuse a single HTTP/2 session instead
 * of paying a full TCP+TLS+ALPN handshake per request; the session must NOT be
 * closed after a successful request — only after the idle TTL or on error.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { replayRequest, clearHttp2SessionCache } from '@server/domains/network/replay';
import type { ReplayArgs } from '@server/domains/network/replay';

const lookupMock = vi.fn();
const connectCount = vi.hoisted<{ value: number }>(() => ({ value: 0 }));
const closeCount = vi.hoisted<{ value: number }>(() => ({ value: 0 }));
const sessions = vi.hoisted<{ value: import('node:http2').ClientHttp2Session[] }>(() => ({
  value: [],
}));

vi.mock('node:dns/promises', () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

vi.mock('node:http2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http2')>();
  const { EventEmitter } = await import('node:events');
  return {
    ...actual,
    connect: vi.fn(() => {
      connectCount.value += 1;
      const session = new EventEmitter() as import('node:http2').ClientHttp2Session;
      (session as any).close = vi.fn(() => {
        closeCount.value += 1;
        session.emit('close');
      });
      (session as any).destroy = vi.fn(() => {
        closeCount.value += 1;
        session.emit('close');
      });
      (session as any).request = vi.fn(() => {
        const request = new EventEmitter() as any;
        request.write = vi.fn();
        request.end = vi.fn(() => {
          request.emit('response', { ':status': 200, 'content-type': 'text/plain' });
          request.emit('data', Buffer.from('ok'));
          request.emit('end');
        });
        return request;
      });
      sessions.value.push(session);
      return session;
    }),
  };
});

const TEST_PUBLIC_IP = '93.184.216.34';

function h2Base() {
  return {
    url: 'https://example.com/api/data',
    method: 'GET',
    headers: {},
    protocol: 'h2',
  };
}

function h2Args(): ReplayArgs {
  return {
    requestId: 'req-session-cache',
    dryRun: false,
    authorization: { allowedHosts: ['example.com'] },
  };
}

describe('replayRequest - HTTP/2 session cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearHttp2SessionCache();
    connectCount.value = 0;
    closeCount.value = 0;
    sessions.value = [];
  });

  it('reuses a single session across replays to the same origin', async () => {
    lookupMock.mockResolvedValue({ address: TEST_PUBLIC_IP, family: 4 });

    await replayRequest(h2Base(), h2Args());
    await replayRequest(h2Base(), h2Args());

    expect(connectCount.value).toBe(1);
  });

  it('keeps separate sessions for different origins', async () => {
    lookupMock.mockResolvedValue({ address: TEST_PUBLIC_IP, family: 4 });

    await replayRequest(h2Base(), h2Args());
    await replayRequest(
      { url: 'https://example.org/api/data', method: 'GET', headers: {}, protocol: 'h2' },
      { requestId: 'req-other', dryRun: false, authorization: { allowedHosts: ['example.org'] } },
    );

    expect(connectCount.value).toBe(2);
  });

  it('does not close the session after a successful request', async () => {
    lookupMock.mockResolvedValue({ address: TEST_PUBLIC_IP, family: 4 });

    await replayRequest(h2Base(), h2Args());

    expect(closeCount.value).toBe(0);
  });

  it('evicts a session after an error so the next replay reconnects', async () => {
    lookupMock.mockResolvedValue({ address: TEST_PUBLIC_IP, family: 4 });

    await replayRequest(h2Base(), h2Args());
    expect(connectCount.value).toBe(1);

    // Simulate the connection failing (e.g. server closes / network reset).
    sessions.value[0]!.emit('error', new Error('connection reset'));

    await replayRequest(h2Base(), h2Args());
    expect(connectCount.value).toBe(2);
  });

  it('reclaims an idle session after the idle TTL', async () => {
    vi.useFakeTimers();
    try {
      lookupMock.mockResolvedValue({ address: TEST_PUBLIC_IP, family: 4 });

      await replayRequest(h2Base(), h2Args());
      expect(connectCount.value).toBe(1);
      expect(closeCount.value).toBe(0);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(closeCount.value).toBe(1);

      await replayRequest(h2Base(), h2Args());
      expect(connectCount.value).toBe(2);
    } finally {
      clearHttp2SessionCache();
      vi.useRealTimers();
    }
  });
});
