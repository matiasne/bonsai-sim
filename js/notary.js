/* Pixel Bonsai — attestation client + verifier.
   An attestation {ts, simT, n, sig} is the server's Ed25519 signature over the
   sha256 of the tree's canonical history prefix (first n events, sim-time simT)
   at server time ts. It proves THE HISTORY'S AGE — this exact prefix existed no
   later than ts — not who grew it. Verification is fully offline: WebCrypto +
   the committed public keys below; the notary server is never consulted.
   Requesting attestations is opportunistic and silent — the game never blocks
   on it and works fully offline. */
(function (root) {
  'use strict';
  const B = root.Bonsai = root.Bonsai || {};

  // Notary public keys (spki der, base64url). Rotation appends — old
  // attestations stay verifiable forever. NEVER accept keys from a URL.
  const PUBKEYS = [];

  const buildMsg = (hash, ts) => 'pixel-bonsai-notary-v1:' + hash + '.' + ts;

  const keyCache = new Map();
  async function importKey(pkB64) {
    if (!keyCache.has(pkB64)) {
      keyCache.set(pkB64, crypto.subtle.importKey(
        'spki', B.Sim.b64u.dec(pkB64), { name: 'Ed25519' }, false, ['verify']
      ));
    }
    return keyCache.get(pkB64);
  }

  const Notary = {
    PUBKEYS,
    buildMsg,

    // Ask the notary to timestamp the tree's current history. Returns the
    // attestation record, or null on any failure (offline, no server, …).
    async attest(env) {
      try {
        const prefix = B.Sim.truncateEnvelope(env, env.t, (env.e || []).length);
        const hash = await B.Sim.hashEnvelope(prefix);
        const r = await fetch('/api/notarize', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hash }),
        });
        if (!r.ok) return null;
        const j = await r.json();
        if (typeof j.ts !== 'number' || typeof j.sig !== 'string') return null;
        return { ts: j.ts, simT: prefix.t, n: prefix.e.length, sig: j.sig };
      } catch (e) { return null; }
    },

    // Offline verification: does this attestation really cover a prefix of
    // this envelope, signed by a known notary key? Never throws.
    async verify(env, att, pubkeys) {
      try {
        const keys = pubkeys || PUBKEYS;
        if (!att || !Number.isInteger(att.n) || !Number.isFinite(att.simT) ||
            !Number.isFinite(att.ts) || typeof att.sig !== 'string' ||
            att.n < 0 || att.n > (env.e || []).length || att.simT > env.t) return false;
        const hash = await B.Sim.hashEnvelope(B.Sim.truncateEnvelope(env, att.simT, att.n));
        const msg = new TextEncoder().encode(buildMsg(hash, att.ts));
        const sig = B.Sim.b64u.dec(att.sig);
        for (const pk of keys) {
          try {
            if (await crypto.subtle.verify('Ed25519', await importKey(pk), sig, msg)) return true;
          } catch (e) { /* bad/unsupported key — try the next */ }
        }
        return false;
      } catch (e) { return false; }
    },

    // Compact URL codec: [[ts, simT, n, sig], …] as base64url JSON (ASCII-safe).
    encodeAtts(list) {
      const rows = list.map(a => [a.ts, a.simT, a.n, a.sig]);
      const json = JSON.stringify(rows);
      return btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    decodeAtts(str) {
      const json = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
      const rows = JSON.parse(json);
      if (!Array.isArray(rows)) return [];
      return rows.slice(0, 8).map(r => ({ ts: r[0], simT: r[1], n: r[2], sig: r[3] }));
    },

    // Which attestations travel in a share URL: the first (the age claim),
    // the latest, and up to `max`-2 spread between.
    pickShareSubset(atts, max) {
      max = max || 8;
      if (atts.length <= max) return atts.slice();
      const out = [atts[0]];
      const middle = atts.slice(1, -1);
      const want = max - 2;
      for (let i = 0; i < want; i++) {
        out.push(middle[Math.round((i + 1) * (middle.length - 1) / (want + 1))]);
      }
      out.push(atts[atts.length - 1]);
      return out;
    },
  };

  B.Notary = Notary;
  if (typeof module !== 'undefined' && module.exports) module.exports = B;
})(typeof window !== 'undefined' ? window : globalThis);
