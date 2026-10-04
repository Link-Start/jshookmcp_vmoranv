/**
 * OCR-audit fix: SQXTN2/UQXTN2 narrowing placement.
 *
 * ARM ARM (SQXTN#advsimd): elements = datasize DIV esize with datasize=64 and
 * 2*esize-wide source elements — the FULL 128-bit Vn is narrowed; Q selects
 * Vpart(d, Q): Q=0 writes the low 64 bits (upper half cleared), Q=1 writes the
 * UPPER 64 bits leaving the low half unchanged. The previous neonSqxtn /
 * neonUqxtn halved the lane count for Q=1, so they read only the low half of
 * Vn and wrote the narrowed results into the middle of the destination.
 *
 * These tests call the live dispatcher-path helpers (simd-neon-saturating)
 * directly; the dispatcher pre-fills the result with the old Vd for Q=1.
 */
import { describe, expect, it } from 'vitest';
import {
  neonSqxtn,
  neonUqxtn,
  type SaturatingContext,
} from '@modules/native-emulator/simd-neon-saturating';

const ctx: SaturatingContext = { setQC: () => undefined };

const v = (...bytes: number[]): Uint8Array => {
  const o = new Uint8Array(16);
  o.set(bytes);
  return o;
};

const i16 = (...lanes: number[]): Uint8Array => {
  const o = new Uint8Array(16);
  const dv = new DataView(o.buffer);
  lanes.forEach((x, i) => dv.setInt16(i * 2, x, true));
  return o;
};

describe('SQXTN2/UQXTN2: full-width source, upper-half destination', () => {
  it('SQXTN2 narrows all 8 wide lanes into bytes 8-15, preserving bytes 0-7', () => {
    const vd = v(1, 2, 3, 4, 5, 6, 7, 8); // old destination low half
    const vn = i16(256, -129, 100, -50, 7, 8, 9, 10);
    neonSqxtn(vd, vn, 0, 1, ctx);
    expect(Array.from(vd.slice(0, 8))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // 256 → 127 (sat), -129 → -128, 100, -50 pass through as bytes
    expect(Array.from(vd.slice(8, 16))).toEqual([127, 128, 100, 206, 7, 8, 9, 10]);
  });

  it('UQXTN2 narrows all 8 wide lanes into bytes 8-15, preserving bytes 0-7', () => {
    const vd = v(9, 8, 7, 6, 5, 4, 3, 2);
    const vn = i16(256, 100, 3, 4, 5, 6, 7, 8);
    neonUqxtn(vd, vn, 0, 1, ctx);
    expect(Array.from(vd.slice(0, 8))).toEqual([9, 8, 7, 6, 5, 4, 3, 2]);
    expect(Array.from(vd.slice(8, 16))).toEqual([255, 100, 3, 4, 5, 6, 7, 8]);
  });

  it('SQXTN Q=0 still writes only the low half (regression guard)', () => {
    const out = new Uint8Array(16);
    neonSqxtn(out, i16(256, -129), 0, 0, ctx);
    expect(out[0]).toBe(127);
    expect(out[1]).toBe(128);
    expect(out[8]).toBe(0);
  });
});
