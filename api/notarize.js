/* Pixel Bonsai — timestamp notary (Vercel serverless function).
   POST {hash: <64-hex sha256 of a canonical envelope prefix>} →
   {ts, sig: ed25519(NOTARY_KEY, MSG(hash, ts))}.
   The server signs WITH ITS OWN CLOCK — that is the whole service: an
   attestation proves the hashed history existed no later than ts. It cannot
   be backdated, and the hash binds one exact tree history.
   Key: env NOTARY_KEY = base64url(pkcs8 der ed25519 private key); the matching
   public key is committed in js/notary.js PUBKEYS. */
'use strict';
const crypto = require('crypto');

const MSG = (hash, ts) => 'pixel-bonsai-notary-v1:' + hash + '.' + ts;

let keyCache = null;
function privateKey(keyB64) {
  if (!keyCache) {
    keyCache = crypto.createPrivateKey({
      key: Buffer.from(keyB64, 'base64url'),
      format: 'der',
      type: 'pkcs8',
    });
  }
  return keyCache;
}

function sign(hash, ts, keyB64) {
  return crypto.sign(null, Buffer.from(MSG(hash, ts)), privateKey(keyB64)).toString('base64url');
}

function handler(req, res) {
  res.setHeader('cache-control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.NOTARY_KEY) return res.status(503).json({ error: 'notary key not configured' });
  const hash = req.body && req.body.hash;
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    return res.status(400).json({ error: 'hash must be 64 lowercase hex chars' });
  }
  const ts = Date.now();
  return res.status(200).json({ ts, sig: sign(hash, ts, process.env.NOTARY_KEY) });
}

module.exports = handler;
module.exports.sign = sign;
module.exports.MSG = MSG;
module.exports._resetKeyCache = () => { keyCache = null; };
