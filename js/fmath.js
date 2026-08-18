/* Pixel Bonsai — pinned transcendental math (B.FMath).

   WHY: IEEE-754 (and the ES spec) exactly specify +, -, *, /, %, sqrt and the
   integer ops — but leave sin/cos/acos/exp/log/pow/hypot "implementation-
   approximated". V8, JavaScriptCore and SpiderMonkey each round those
   differently in the last bits, so the sim's replay guarantee ("the envelope
   IS the tree") only held per-engine. This module reimplements the handful of
   transcendentals the replay path uses as fixed polynomial approximations
   (fdlibm coefficients) built ONLY from exactly-specified operations, so v3
   envelopes re-derive bit-identical trees on every engine and platform.

   LEGACY: v2 envelopes must keep replaying exactly as they always did, so
   every function passes through to native Math while FMath.legacy is true.
   B.Sim sets the flag from the envelope version at every entry point
   (newState/step/applyAction) — nothing else should touch it.

   Accuracy: within ~1e-14 of correctly-rounded over the sim's input ranges
   (|x| ≲ 1e3 for trig — reduction is single-stage, NOT Payne-Hanek).
   Determinism is the contract here, not perfect rounding. */
(function (root) {
  'use strict';
  const B = root.Bonsai = root.Bonsai || {};

  // ---- exact bit access. DataView's default byte order is fixed big-endian,
  // so these are deterministic even across host endianness.
  const dv = new DataView(new ArrayBuffer(8));
  const HI = (x) => { dv.setFloat64(0, x); return dv.getUint32(0); };
  const setHI = (x, h) => { dv.setFloat64(0, x); dv.setUint32(0, h >>> 0); return dv.getFloat64(0); };
  const pow2 = (k) => { dv.setUint32(0, (k + 1023) << 20); dv.setUint32(4, 0); return dv.getFloat64(0); }; // 2^k, k ∈ [-1022, 1023]

  // ---- sin/cos: quadrant reduction + fdlibm kernel polynomials
  const INV_PIO2 = 6.36619772367581382433e-01;  // 2/π
  const PIO2_1 = 1.57079632673412561417e+00;    // first 33 bits of π/2 (n·PIO2_1 stays exact)
  const PIO2_1T = 6.07710050650619224932e-11;   // π/2 − PIO2_1
  const S1 = -1.66666666666666324348e-01, S2 = 8.33333333332248946124e-03,
    S3 = -1.98412698298579493134e-04, S4 = 2.75573137070700676789e-06,
    S5 = -2.50507602534068634195e-08, S6 = 1.58969099521155010221e-10;
  const C1 = 4.16666666666666019037e-02, C2 = -1.38888888888741095749e-03,
    C3 = 2.48015872894767294178e-05, C4 = -2.75573143513906633035e-07,
    C5 = 2.08757232129817482790e-09, C6 = -1.13596475577881948265e-11;

  function ksin(r) { const z = r * r; return r + r * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * (S5 + z * S6))))); }
  function kcos(r) { const z = r * r; return 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))))); }

  function _sin(x) {
    if (!isFinite(x)) return NaN;
    const n = Math.round(x * INV_PIO2);                 // Math.round is exactly specified
    const r = (x - n * PIO2_1) - n * PIO2_1T;
    const q = ((n % 4) + 4) % 4;
    return q === 0 ? ksin(r) : q === 1 ? kcos(r) : q === 2 ? -ksin(r) : -kcos(r);
  }
  function _cos(x) {
    if (!isFinite(x)) return NaN;
    const n = Math.round(x * INV_PIO2);
    const r = (x - n * PIO2_1) - n * PIO2_1T;
    const q = ((n % 4) + 4) % 4;
    return q === 0 ? kcos(r) : q === 1 ? -ksin(r) : q === 2 ? -kcos(r) : ksin(r);
  }

  // ---- acos: fdlibm rational approximation (asin kernel)
  const PIO2_HI = 1.57079632679489655800e+00, PIO2_LO = 6.12323399573676603587e-17;
  const PI = 3.14159265358979311600e+00;
  const pS0 = 1.66666666666666657415e-01, pS1 = -3.25565818622400915405e-01,
    pS2 = 2.01212532134862925881e-01, pS3 = -4.00555345006794114027e-02,
    pS4 = 7.91534994289814532176e-04, pS5 = 3.47933107596021167570e-05;
  const qS1 = -2.40339491173441421878e+00, qS2 = 2.02094576023350569471e+00,
    qS3 = -6.88283971605453293030e-01, qS4 = 7.70381505559019352791e-02;

  function rasin(z) {
    const p = z * (pS0 + z * (pS1 + z * (pS2 + z * (pS3 + z * (pS4 + z * pS5)))));
    const q = 1 + z * (qS1 + z * (qS2 + z * (qS3 + z * qS4)));
    return p / q;
  }
  function _acos(x) {
    if (!(x >= -1 && x <= 1)) return NaN;
    if (x === 1) return 0;
    if (x === -1) return PI;
    if (x > -0.5 && x < 0.5) return PIO2_HI - (x - (PIO2_LO - x * rasin(x * x)));
    if (x < 0) { const z = (1 + x) * 0.5, s = Math.sqrt(z); return PI - 2 * (s + (s * rasin(z) - PIO2_LO)); }
    const z = (1 - x) * 0.5, s = Math.sqrt(z);
    return 2 * (s + s * rasin(z));
  }

  // ---- log / log10: fdlibm e_log
  const LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10;
  const IVLN10 = 4.34294481903251816668e-01;
  const Lg1 = 6.666666666666735130e-01, Lg2 = 3.999999999940941908e-01,
    Lg3 = 2.857142874366239149e-01, Lg4 = 2.222219843214978396e-01,
    Lg5 = 1.818357216161805012e-01, Lg6 = 1.531383769920937332e-01,
    Lg7 = 1.479819860511658591e-01;

  function _log(x) {
    if (x === 0) return -Infinity;
    if (!(x > 0)) return NaN;
    if (x === Infinity) return Infinity;
    let k = 0, h = HI(x);
    if (h < 0x00100000) { x *= 18014398509481984; k -= 54; h = HI(x); }   // subnormal → ×2^54
    k += (h >> 20) - 1023;
    h &= 0x000fffff;
    const i = (h + 0x95f64) & 0x100000;
    x = setHI(x, h | (i ^ 0x3ff00000));         // mantissa scaled into [√2/2, √2)
    k += i >> 20;
    const f = x - 1;
    const s = f / (2 + f), z = s * s, w = z * z;
    const t1 = w * (Lg2 + w * (Lg4 + w * Lg6));
    const t2 = z * (Lg1 + w * (Lg3 + w * (Lg5 + w * Lg7)));
    const R = t2 + t1, hfsq = 0.5 * f * f;
    return k * LN2_HI - ((hfsq - (s * (hfsq + R) + k * LN2_LO)) - f);
  }

  // ---- exp: fdlibm e_exp
  const INVLN2 = 1.44269504088896338700e+00;
  const P1 = 1.66666666666666019037e-01, P2 = -2.77777777770155933842e-03,
    P3 = 6.61375632143793436117e-05, P4 = -1.65339022054652515390e-06,
    P5 = 4.13813679705723846039e-08;

  function _exp(x) {
    if (x !== x) return NaN;
    if (x > 709.782712893384) return Infinity;
    if (x < -745.133219101941) return 0;
    const k = Math.round(x * INVLN2);
    const hi = x - k * LN2_HI, lo = k * LN2_LO;
    const r = hi - lo, t = r * r;
    const c = r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
    const y = 1 - ((lo - (r * c) / (2 - c)) - hi);
    if (k === 0) return y;
    if (k >= -1021 && k <= 1023) return y * pow2(k);
    return k > 0 ? y * pow2(1023) * pow2(k - 1023) : y * pow2(-1021) * pow2(k + 1021);
  }

  function _pow(x, y) {
    if (y === 0) return 1;
    if (x === 1) return 1;
    if (x !== x || y !== y) return NaN;
    if (x === 0) return y > 0 ? 0 : Infinity;
    if (x < 0) {
      if (!Number.isInteger(y)) return NaN;
      const v = _exp(y * _log(-x));
      return y % 2 === 0 ? v : -v;
    }
    return _exp(y * _log(x));
  }

  // hypot as sqrt of the exact dot product — sqrt IS exactly specified, so this
  // is deterministic where native Math.hypot is not. No overflow staging: tree
  // coordinates are ≲ 50, nowhere near 1e154.
  function _hypot2(x, y) { return Math.sqrt(x * x + y * y); }
  function _hypot3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }

  const FM = {
    legacy: false,   // true → pass through to native Math (bug-for-bug v2 replays)
    sin: (x) => FM.legacy ? Math.sin(x) : _sin(x),
    cos: (x) => FM.legacy ? Math.cos(x) : _cos(x),
    acos: (x) => FM.legacy ? Math.acos(x) : _acos(x),
    log: (x) => FM.legacy ? Math.log(x) : _log(x),
    log10: (x) => FM.legacy ? Math.log10(x) : _log(x) * IVLN10,
    exp: (x) => FM.legacy ? Math.exp(x) : _exp(x),
    pow: (x, y) => FM.legacy ? Math.pow(x, y) : _pow(x, y),
    hypot2: (x, y) => FM.legacy ? Math.hypot(x, y) : _hypot2(x, y),
    hypot3: (x, y, z) => FM.legacy ? Math.hypot(x, y, z) : _hypot3(x, y, z),
  };

  B.FMath = FM;
  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
