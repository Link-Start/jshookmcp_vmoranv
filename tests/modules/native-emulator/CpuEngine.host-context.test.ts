/**
 * Regression: CpuEngine.hostContext() must expose the optional HostContext
 * memory-value hooks (loadValue/storeValue) declared in host-context.ts.
 * bionic stubs (strtok_r, strsep, div, ldiv) call them with non-null
 * assertions, but the real engine's hostContext omitted both — every guest
 * calling those libc imports crashed with "ctx.loadValue is not a function".
 * The mock contexts in bionic tests supply their own hooks and masked the gap;
 * these tests run the stubs against the REAL engine via bindImportStub +
 * callHost.
 */
import { describe, expect, it } from 'vitest';

import { CpuEngine } from '@modules/native-emulator/CpuEngine';
import { createBionicLibrary, type BionicMemoryMapper } from '@modules/native-emulator/bionic';

const NOOP_RUNTIME: BionicMemoryMapper = {
  mapMemory: () => undefined,
  lookupSymbol: () => undefined,
  bindImportStub: () => 1,
  callGuestFunction: () => 0,
};

/** Runtime that forwards bionic heap allocations into the real engine. */
function engineRuntime(engine: CpuEngine): BionicMemoryMapper {
  return {
    ...NOOP_RUNTIME,
    mapMemory: (addr, size) => engine.mapMemory(addr, size),
  };
}

const BASE = 0x10000;
const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Map a page, install a bionic stub, set x0..x2 and invoke it via callHost. */
function callStub(name: string, x0: number, x1: number, x2: number): CpuEngine {
  const engine = new CpuEngine();
  engine.mapMemory(BASE, 0x1000);
  const lib = createBionicLibrary(engineRuntime(engine));
  const stub = engine.bindImportStub(name, lib.get(name)!);
  engine.writeRegister('x0', x0);
  engine.writeRegister('x1', x1);
  engine.writeRegister('x2', x2);
  engine.callHost(stub);
  return engine;
}

describe('CpuEngine hostContext — loadValue/storeValue wiring', () => {
  it('strtok_r via the real engine tokenises and resumes through *saveptr', () => {
    const engine = new CpuEngine();
    engine.mapMemory(BASE, 0x1000);
    engine.writeCode(BASE + 0x100, ascii('a,b\0'));
    engine.writeCode(BASE + 0x200, ascii(',\0'));

    const lib = createBionicLibrary(engineRuntime(engine));
    const stub = engine.bindImportStub('strtok_r', lib.get('strtok_r')!);

    // strtok_r("a,b", ",", &saveptr) → "a", *saveptr → &"b"
    engine.writeRegister('x0', BASE + 0x100);
    engine.writeRegister('x1', BASE + 0x200);
    engine.writeRegister('x2', BASE + 0x300);
    engine.callHost(stub);
    expect(engine.readRegister('x0')).toBe(BASE + 0x100);

    // strtok_r(NULL, ",", &saveptr) → "b" (resumes from *saveptr)
    engine.writeRegister('x0', 0);
    engine.callHost(stub);
    expect(engine.readRegister('x0')).toBe(BASE + 0x102);
  });

  it('strsep via the real engine splits on the delimiter and updates *stringp', () => {
    const engine = new CpuEngine();
    engine.mapMemory(BASE, 0x1000);
    engine.writeCode(BASE + 0x100, ascii('left|right\0'));
    engine.writeCode(BASE + 0x200, ascii('|\0'));
    // stringp slot at BASE+0x300 holds the string pointer 0x10100 (8-byte LE)
    engine.writeCode(BASE + 0x300, Uint8Array.of(0x00, 0x01, 0x01, 0, 0, 0, 0, 0));

    const lib = createBionicLibrary(engineRuntime(engine));
    const stub = engine.bindImportStub('strsep', lib.get('strsep')!);
    engine.writeRegister('x0', BASE + 0x300);
    engine.writeRegister('x1', BASE + 0x200);
    engine.callHost(stub);

    expect(engine.readRegister('x0')).toBe(BASE + 0x100); // token "left"
    // '|' at BASE+0x104 replaced by NUL; *stringp → BASE+0x105 ("right")
    const updated = engine.readMemory(BASE + 0x300, 8);
    expect(Array.from(updated)).toEqual([0x05, 0x01, 0x01, 0, 0, 0, 0, 0]);
    expect(engine.readMemory(BASE + 0x104, 1)[0]).toBe(0);
  });

  it('div via the real engine writes quot/rem through storeValue', () => {
    const engine = callStub('div', 7, 2, 0);
    const ptr = engine.readRegister('x0');
    // div_t { int quot; int rem; } = { 3, 1 }, little-endian
    expect(Array.from(engine.readMemory(ptr, 8))).toEqual([3, 0, 0, 0, 1, 0, 0, 0]);
  });

  it('ldiv via the real engine writes 8-byte quot/rem fields', () => {
    const engine = callStub('ldiv', 100, 7, 0);
    const ptr = engine.readRegister('x0');
    const bytes = Array.from(engine.readMemory(ptr, 16));
    expect(bytes.slice(0, 8)).toEqual([14, 0, 0, 0, 0, 0, 0, 0]); // quot 14
    expect(bytes.slice(8, 16)).toEqual([2, 0, 0, 0, 0, 0, 0, 0]); // rem 2
  });
});
