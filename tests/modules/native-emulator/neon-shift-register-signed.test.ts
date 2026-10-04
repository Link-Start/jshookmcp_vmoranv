/**
 * OCR-audit fix: SQSHL/UQSHL/SQRSHL/UQRSHL (register) shift-amount semantics.
 *
 * ARM ARM (SQSHL (register)): the shift is the SIGNED value of the Vm lane —
 * a negative shift amount is a right shift (arithmetic for the signed forms,
 * logical for the unsigned forms). The previous implementation masked the lane
 * with 0xff before the sign test, so every negative amount became a large
 * positive left shift that saturated instead of shifting right.
 */
import { describe, expect, it } from 'vitest';
import {
  neonSqshl,
  neonUqshl,
  neonSqrshl,
  neonUqrshl,
  type SaturatingContext,
} from '@modules/native-emulator/simd-neon-saturating';

const v = (...bytes: number[]): Uint8Array => {
  const o = new Uint8Array(16);
  o.set(bytes);
  return o;
};

const ctxWith = (): { ctx: SaturatingContext; qc: () => number } => {
  let count = 0;
  return { ctx: { setQC: () => void count++ }, qc: () => count };
};

describe('register saturating shifts: negative Vm lane = right shift (ARM ARM)', () => {
  it('SQSHL: Vm=-1 arithmetic right-shifts Vn by 1 (no saturation)', () => {
    const { ctx, qc } = ctxWith();
    const out = new Uint8Array(16);
    neonSqshl(out, v(0x08), v(0xff), 0, 0, ctx); // 8 ASR 1 → 4
    expect(out[0]).toBe(4);
    expect(qc()).toBe(0);
  });

  it('UQSHL: Vm=-1 logical right-shifts Vn by 1', () => {
    const { ctx } = ctxWith();
    const out = new Uint8Array(16);
    neonUqshl(out, v(0xff), v(0xff), 0, 0, ctx); // 255 LSR 1 → 127
    expect(out[0]).toBe(127);
  });

  it('SQRSHL: Vm=-2 rounding right shift (10 + 2) >> 2 = 3', () => {
    const { ctx, qc } = ctxWith();
    const out = new Uint8Array(16);
    neonSqrshl(out, v(0x0a), v(0xfe), 0, 0, ctx);
    expect(out[0]).toBe(3);
    expect(qc()).toBe(0);
  });

  it('UQRSHL: Vm=-2 rounding right shift (10 + 2) >> 2 = 3', () => {
    const { ctx } = ctxWith();
    const out = new Uint8Array(16);
    neonUqrshl(out, v(0x0a), v(0xfe), 0, 0, ctx);
    expect(out[0]).toBe(3);
  });

  it('SQSHL: shift <= -esize replicates the sign bits without QC', () => {
    const { ctx, qc } = ctxWith();
    const out = new Uint8Array(16);
    neonSqshl(out, v(0x80), v(0x80), 0, 0, ctx); // -128 ASR 128 → -1 (0xff)
    expect(out[0]).toBe(0xff);
    expect(qc()).toBe(0);
  });

  it('positive shifts still saturate and set QC (regression guard)', () => {
    const { ctx, qc } = ctxWith();
    const out = new Uint8Array(16);
    neonSqshl(out, v(64), v(2), 0, 0, ctx); // 64 << 2 = 256 → sat 127 + QC
    expect(out[0]).toBe(127);
    expect(qc()).toBe(1);
  });
});
