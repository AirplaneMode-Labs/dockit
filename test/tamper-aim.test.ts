import { describe, expect, it } from 'vitest';
import { assertWellAimed, breakJson, flipHashDigit, hashDigitOffset } from './helpers/tamper.ts';

// BUG-T1-S5-02: the tamper cases of e2e.spec.ts used indexOf('"sha256":"') + 12 on a manifest that is pretty-printed
// ('"sha256": "'), so indexOf was -1 and the flip landed on byte 11, inside the '"spec"' line: the refusal they saw was 'parse', and
// the stored manifest's signature re-verification (S-OFF-1) was never reached. These tests pin the aim.
const entry = (hex: string) => ({
  id: 'x.onnx',
  kind: 'model',
  url: 'models/x.onnx',
  sha256: hex,
  size: 12,
});
const HEX_A = 'cb99455288675345e1a4f411a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEX_B = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const body = {
  spec: 'airplanemode.manifest/0.1',
  id: 'dev.airplanemode.dockit-models',
  entries: [entry(HEX_A), entry(HEX_B)],
};
const enc = (s: string) => new TextEncoder().encode(s);
const pretty = enc(`${JSON.stringify(body, null, 2)}\n`);
const compact = enc(JSON.stringify(body));
const text = (b: Uint8Array) => new TextDecoder().decode(b);

/** The aim the Sprint 5 spec used before the fix. */
function legacyAim(bytes: Uint8Array): Uint8Array {
  const v = new Uint8Array(bytes);
  const at = text(v).indexOf('"sha256":"') + 12;
  v[at] = v[at]! ^ 3;
  return v;
}

describe('tamper aim (BUG-T1-S5-02)', () => {
  it.each([
    ['a pretty-printed manifest (the one bundle-models writes)', pretty],
    ['a compact manifest', compact],
  ])(
    'flipHashDigit changes exactly one hex digit inside a sha256 value of %s, and it still parses',
    (_n, bytes) => {
      const t = flipHashDigit(bytes);
      expect(t.bytes).toHaveLength(bytes.length);
      expect(t.before).toMatch(/^[0-9a-f]$/);
      expect(t.after).toMatch(/^[0-9a-f]$/);
      expect(t.after).not.toBe(t.before);
      expect(() => JSON.parse(text(t.bytes))).not.toThrow();
      expect(() => assertWellAimed(bytes, t.bytes)).not.toThrow();
      // the digit is the third one of the first sha256 value
      expect(t.offset).toBe(hashDigitOffset(text(bytes)));
      expect(text(bytes).slice(t.offset - 2, t.offset)).toBe(HEX_A.slice(0, 2));
      // the signed content changed, so JSON.parse(...).entries[0].sha256 is a different 64-digit hash
      expect((JSON.parse(text(t.bytes)) as typeof body).entries[0]!.sha256).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect((JSON.parse(text(t.bytes)) as typeof body).entries[0]!.sha256).not.toBe(HEX_A);
    },
  );

  it('every hex digit maps to a different hex digit (no digit leaves the hex alphabet)', () => {
    for (const d of '0123456789abcdef') {
      const sample = enc(`{"sha256": "ab${d}${'0'.repeat(61)}"}`);
      const t = flipHashDigit(sample);
      expect(t.before).toBe(d);
      expect(t.after).toMatch(/^[0-9a-f]$/);
      expect(t.after).not.toBe(d);
    }
  });

  it('the legacy aim lands outside every sha256 value of a pretty-printed manifest, and assertWellAimed rejects it', () => {
    const old = legacyAim(pretty);
    expect(text(old).indexOf('"sha256":"')).toBe(-1); // the lookup that never matched
    expect(() => assertWellAimed(pretty, old)).toThrow(/not inside a sha256 value|not a hex digit/);
    // and it did break the JSON, which is why the old test saw 'parse'
    expect(() => JSON.parse(text(old))).toThrow();
  });

  it('assertWellAimed also rejects: no change, two changes, a different length, a flip that is not valid JSON', () => {
    expect(() => assertWellAimed(pretty, new Uint8Array(pretty))).toThrow(/exactly one byte/);
    const two = new Uint8Array(pretty);
    const i = hashDigitOffset(text(pretty));
    two[i] = two[i] === 0x61 ? 0x62 : 0x61;
    two[i + 1] = two[i + 1] === 0x61 ? 0x62 : 0x61;
    expect(() => assertWellAimed(pretty, two)).toThrow(/exactly one byte/);
    expect(() => assertWellAimed(pretty, pretty.slice(1))).toThrow(/length/);
    const nonHex = new Uint8Array(pretty);
    nonHex[i] = 0x67; // 'g'
    expect(() => assertWellAimed(pretty, nonHex)).toThrow(/not a hex digit/);
  });

  it('hashDigitOffset throws when the text has no sha256 value instead of returning a wrong offset', () => {
    expect(() => hashDigitOffset('{"spec": "x"}')).toThrow(/sha256/);
  });

  it('breakJson is the explicit parse-failure case: it no longer parses, and differs in one byte', () => {
    const b = breakJson(pretty);
    expect(() => JSON.parse(text(b))).toThrow();
    expect(b).toHaveLength(pretty.length);
    expect([...b].filter((x, k) => x !== pretty[k])).toHaveLength(1);
  });
});
