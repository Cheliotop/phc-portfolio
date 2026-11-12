import { bytesToHex, hexToBytes, hmacSha256, pbkdf2HmacSha256, sha256 } from '../src/utils/passwordKdf';

const ascii = (text: string) => Array.from(text, (character) => character.charCodeAt(0));

describe('local SHA-256 key derivation', () => {
  it('matches the FIPS 180 SHA-256 vector for "abc"', () => {
    expect(bytesToHex(sha256(ascii('abc')))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('matches RFC 4231 HMAC-SHA256 test case 1', () => {
    expect(bytesToHex(hmacSha256(new Array(20).fill(0x0b), ascii('Hi There'))))
      .toBe('b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
  });

  it('matches RFC 4231 HMAC-SHA256 test case 2', () => {
    expect(bytesToHex(hmacSha256(ascii('Jefe'), ascii('what do ya want for nothing?'))))
      .toBe('5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
  });

  it('matches RFC 7914 section 11 PBKDF2-HMAC-SHA256 vector (P="passwd", S="salt", c=1)', () => {
    expect(bytesToHex(pbkdf2HmacSha256('passwd', ascii('salt'), 1, 64)))
      .toBe('55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc'
        + '49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783');
  });

  it('matches RFC 7914 section 11 PBKDF2-HMAC-SHA256 vector (P="Password", S="NaCl", c=80000)', () => {
    expect(bytesToHex(pbkdf2HmacSha256('Password', ascii('NaCl'), 80000, 64)))
      .toBe('4ddcd8f60b98be21830cee5ef22701f9641a4418d04c0414aeff08876b34ab56'
        + 'a1d425a1225833549adb841b51c9b3176a272bdebba1d078478f62b397f33c8d');
  }, 60_000);

  it('round-trips hex encoding', () => {
    expect(bytesToHex(hexToBytes('00ff10'))).toBe('00ff10');
  });
});
