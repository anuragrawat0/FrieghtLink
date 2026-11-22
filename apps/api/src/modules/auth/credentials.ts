import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const emailPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const emailMaxLength = 254;
export const passwordLength = { minLength: 12, maxLength: 128 } as const;

const options = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const prefix = `scrypt$${options.N}$${options.r}$${options.p}$${options.maxmem}$`;
const saltLength = 16;
const keyLength = 64;
const dummySalt = Buffer.alloc(saltLength);
const dummyKey = Buffer.alloc(keyLength);

function deriveKey(password: string, salt: Buffer) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string) {
  const salt = randomBytes(saltLength);
  const key = await deriveKey(password, salt);
  return `${prefix}${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password: string, storedHash: string | undefined) {
  const encoded = storedHash?.startsWith(prefix) ? storedHash.slice(prefix.length) : "";
  const parts = /^([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(encoded);
  // Run the same derivation for unknown accounts and invalid stored hashes.
  const salt = parts ? Buffer.from(parts[1], "hex") : dummySalt;
  const expected = parts ? Buffer.from(parts[2], "hex") : dummyKey;
  const key = await deriveKey(password, salt);
  const matches = timingSafeEqual(key, expected);
  return parts !== null && matches;
}
