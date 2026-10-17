// =========================================================================
//  Self-signed X.509 certificate in plain Node — no openssl binary, no
//  dependency. Node can generate keys and sign, but has no API to *build* a
//  certificate, so the DER structure (RFC 5280) is encoded by hand below.
//
//  Mirrors what `openssl req -x509 -nodes -newkey rsa:2048 -days N -subj
//  /CN=…` produces with OpenSSL 3 defaults: X.509 v3, RSA 2048,
//  sha256WithRSAEncryption, subject = issuer = CN, and the extensions of a
//  certificate the SHC is known to accept: subjectKeyIdentifier and
//  basicConstraints CA:TRUE (critical). OpenSSL 3 omits the
//  authorityKeyIdentifier on self-signed certificates, so we do too. The
//  key is written as unencrypted PKCS#8 ("BEGIN PRIVATE KEY"), same as
//  openssl.
// =========================================================================
const crypto = require('crypto');

// ---- minimal DER encoder ------------------------------------------------
function derLength(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, ...parts) => {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
const set = (...parts) => tlv(0x31, ...parts);
const explicit = (n, ...parts) => tlv(0xa0 | n, ...parts); // [n] EXPLICIT, constructed
const octetString = (buf) => tlv(0x04, buf);
const bitString = (buf) => tlv(0x03, Buffer.from([0]), buf); // 0 unused bits
const nullValue = () => Buffer.from([0x05, 0x00]);
const boolTrue = () => Buffer.from([0x01, 0x01, 0xff]);
const utf8String = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));

// Unsigned big-endian bytes → DER INTEGER (minimal, non-negative).
function integer(buf) {
  let i = 0;
  while (i < buf.length - 1 && buf[i] === 0) i++;
  let b = buf.subarray(i);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

function oid(dotted) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const out = [40 * a + b];
  for (const n of rest) {
    const chunk = [n & 0x7f];
    for (let v = n >>> 7; v > 0; v >>>= 7) chunk.unshift(0x80 | (v & 0x7f));
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

// RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050 on.
function time(date) {
  const iso = date.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const digits = iso.slice(0, 19).replace(/[-T:]/g, '') + 'Z'; // YYYYMMDDHHMMSSZ
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(digits.slice(2), 'ascii'))
    : tlv(0x18, Buffer.from(digits, 'ascii'));
}

const OID = {
  sha256WithRSA:          '1.2.840.113549.1.1.11',
  commonName:             '2.5.4.3',
  subjectKeyIdentifier:   '2.5.29.14',
  basicConstraints:       '2.5.29.19',
};

const name = (cn) => seq(set(seq(oid(OID.commonName), utf8String(cn))));
const extension = (id, critical, value) =>
  seq(oid(id), ...(critical ? [boolTrue()] : []), octetString(value));

// Returns { cert, key } as PEM strings.
function createSelfSignedCert({ commonName, days = 9999, bits = 2048 } = {}) {
  if (!commonName) throw new Error('commonName required');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: bits });

  const sigAlg = seq(oid(OID.sha256WithRSA), nullValue());
  // Key identifier per RFC 5280 §4.2.1.2 (1): SHA-1 over the subjectPublicKey
  // bit string contents — for RSA that is exactly the PKCS#1 public key DER.
  const keyId = crypto.createHash('sha1').update(publicKey.export({ type: 'pkcs1', format: 'der' })).digest();
  // Positive 159-bit random serial (openssl uses 20 random bytes too).
  const serial = crypto.randomBytes(20);
  serial[0] &= 0x7f;
  serial[0] |= 0x01;

  const notBefore = new Date();
  const notAfter = new Date(notBefore.getTime() + days * 864e5);

  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),        // version v3
    integer(serial),
    sigAlg,
    name(commonName),                               // issuer
    seq(time(notBefore), time(notAfter)),
    name(commonName),                               // subject
    publicKey.export({ type: 'spki', format: 'der' }),
    explicit(3, seq(
      extension(OID.subjectKeyIdentifier, false, octetString(keyId)),
      extension(OID.basicConstraints, true, seq(boolTrue())),             // CA:TRUE
    )),
  );
  const signature = crypto.sign('sha256', tbs, privateKey); // RSA PKCS#1 v1.5
  const der = seq(tbs, sigAlg, bitString(signature));

  const b64 = der.toString('base64').match(/.{1,64}/g).join('\n');
  return {
    cert: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

module.exports = { createSelfSignedCert };
