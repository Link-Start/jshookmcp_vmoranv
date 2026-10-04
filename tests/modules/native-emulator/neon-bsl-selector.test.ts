/**
 * OCR-audit fix: BSL (Bitwise Select) selector semantics.
 *
 * ARM ARM (BSL, AdvSIMD): result = Vm XOR ((Vm XOR Vn) AND Vd), i.e.
 * Vd = (Vd & Vn) | (Vm & ~Vd) — the ORIGINAL destination value is the
 * selector: Vd=1 takes the corresponding bit of Vn (first source), Vd=0 takes
 * Vm (second source). The previous formula complemented Vn instead of the old
 * Vd, computing a different function (which was also identical to neonBif).
 */
import { describe, expect, it } from 'vitest';
import { neonBsl, neonBif } from '@modules/native-emulator/simd-neon';

const v = (...bytes: number[]): Uint8Array => {
  const o = new Uint8Array(16);
  o.set(bytes);
  return o;
};

const lane = (u: Uint8Array, i: number): bigint =>
  BigInt(new DataView(u.buffer, u.byteOffset, 16).getUint8(i));

describe('BSL: the original Vd is the selector (ARM ARM)', () => {
  it('Vd=1 → Vn, Vd=0 → Vm: (Vd & Vn) | (Vm & ~Vd)', () => {
    const vd = v(0b1100_1100);
    const vn = v(0b0101_0101);
    const vm = v(0b1010_1010);
    // Vd=1 bits (1100): take Vn → 0100; Vd=0 bits (0011): take Vm → 0010
    expect(lane(neonBsl(vd, vn, vm, 0), 0)).toBe(0x66n);
  });

  it('BSL is distinct from BIF (selector vs insert-if-false condition)', () => {
    const vd = v(0b1100_1100);
    const vn = v(0b0101_0101);
    const vm = v(0b1010_1010);
    const bsl = lane(neonBsl(vd, vn, vm, 0), 0);
    const bif = lane(neonBif(vd, vn, vm, 0), 0);
    expect(bsl).toBe(0x66n); // BSL, Vd selector: (0x55 & 0xCC) | (0xAA & ~0xCC) = 0x44 | 0x22
    // BIF, Vm selector (insert Vn where Vm=0): (0x55 & ~0xAA) | (0xCC & 0xAA)
    // = 0x55 | 0x88 = 0xDD — distinct from BSL.
    expect(bif).toBe(0xddn);
  });

  it('Q=1 selects across all 16 bytes', () => {
    const vd = v(0xcc, 0x33);
    const vn = v(0xff, 0x0f);
    const vm = v(0x00, 0xf0);
    const out = neonBsl(vd, vn, vm, 1);
    // lane0: (0xCC & 0xFF) | (0x00 & ~0xCC) = 0xCC
    // lane1: (0x33 & 0x0F) | (0xF0 & ~0x33) = 0x03 | 0xC0 = 0xC3
    expect(lane(out, 0)).toBe(0xccn);
    expect(lane(out, 1)).toBe(0xc3n);
  });
});
