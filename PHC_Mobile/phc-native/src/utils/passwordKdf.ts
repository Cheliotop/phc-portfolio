const K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
];
const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
const utf8 = (value: string): number[] => Array.from(unescape(encodeURIComponent(value)), (c) => c.charCodeAt(0));
const concat = (...arrays: number[][]) => arrays.flat();

export const hexToBytes = (hex: string): number[] => hex.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? [];
export const bytesToHex = (bytes: number[]): string => bytes.map((byte) => byte.toString(16).padStart(2, '0')).join('');

export function sha256(message: number[]): number[] {
  const data = message.slice();
  const bitLength = data.length * 8;
  data.push(0x80);
  while (data.length % 64 !== 56) data.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  data.push((high >>> 24)&255,(high >>> 16)&255,(high >>> 8)&255,high&255,(low>>>24)&255,(low>>>16)&255,(low>>>8)&255,low&255);
  const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  for (let offset = 0; offset < data.length; offset += 64) {
    const w = new Array<number>(64);
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = ((data[j] << 24) | (data[j+1] << 16) | (data[j+2] << 8) | data[j+3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const a = w[i-15], b = w[i-2];
      const s0 = rotr(a,7) ^ rotr(a,18) ^ (a >>> 3);
      const s1 = rotr(b,17) ^ rotr(b,19) ^ (b >>> 10);
      w[i] = (w[i-16] + s0 + w[i-7] + s1) >>> 0;
    }
    let [a,b,c,d,e,f,g,h] = hash;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      [h,g,f,e,d,c,b,a] = [g,f,e,(d+t1)>>>0,c,b,a,(t1+t2)>>>0];
    }
    [a,b,c,d,e,f,g,h].forEach((value, i) => { hash[i] = (hash[i] + value) >>> 0; });
  }
  return hash.flatMap((word) => [(word>>>24)&255,(word>>>16)&255,(word>>>8)&255,word&255]);
}

export function hmacSha256(key: number[], message: number[]): number[] {
  let normalized = key.length > 64 ? sha256(key) : key.slice();
  normalized = normalized.concat(new Array(64 - normalized.length).fill(0));
  const inner = normalized.map((v) => v ^ 0x36);
  const outer = normalized.map((v) => v ^ 0x5c);
  return sha256(concat(outer, sha256(concat(inner, message))));
}

export function pbkdf2HmacSha256(password: string, salt: number[], iterations: number, keyLength = 32): number[] {
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('Invalid PBKDF2 iterations');
  if (!Number.isInteger(keyLength) || keyLength < 1) throw new Error('Invalid PBKDF2 key length');
  const secret = utf8(password);
  const output: number[] = [];
  for (let block = 1; output.length < keyLength; block++) {
    const suffix = [(block>>>24)&255,(block>>>16)&255,(block>>>8)&255,block&255];
    let u = hmacSha256(secret, concat(salt, suffix));
    const result = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmacSha256(secret, u);
      for (let j = 0; j < result.length; j++) result[j] ^= u[j];
    }
    output.push(...result);
  }
  return output.slice(0, keyLength);
}

/**
 * Salt bytes. Uses the platform CSPRNG when the runtime exposes one. React
 * Native / Hermes does not, and no crypto dependency may be added, so the
 * fallback mixes time, Math.random and a counter. The salt only has to be
 * unique per operator (it is stored next to the verifier), so this is a known,
 * accepted weakening; see the task's UNSURE notes.
 */
let fallbackCounter = 0;
export function randomBytes(length: number): number[] {
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto;
  if (cryptoApi?.getRandomValues) return Array.from(cryptoApi.getRandomValues(new Uint8Array(length)));
  return Array.from({ length }, () => {
    fallbackCounter = (fallbackCounter + 1) % 256;
    return Math.floor(Math.random() * 256) ^ (Date.now() & 255) ^ fallbackCounter;
  });
}


export async function pbkdf2HmacSha256Async(password: string, salt: number[], iterations: number, keyLength = 32): Promise<number[]> {
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('Invalid PBKDF2 iterations');
  if (!Number.isInteger(keyLength) || keyLength < 1) throw new Error('Invalid PBKDF2 key length');
  const secret = utf8(password);
  const output: number[] = [];
  for (let block = 1; output.length < keyLength; block++) {
    const suffix = [(block>>>24)&255,(block>>>16)&255,(block>>>8)&255,block&255];
    let u = hmacSha256(secret, concat(salt, suffix));
    const result = u.slice();
    for (let i = 1; i < iterations; i++) {
      // Same iterations/output as the synchronous verifier; yield to input and
      // rendering instead of blocking Hermes for the entire derivation.
      if (i % 128 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      u = hmacSha256(secret, u);
      for (let j = 0; j < result.length; j++) result[j] ^= u[j];
    }
    output.push(...result);
  }
  return output.slice(0, keyLength);
}
