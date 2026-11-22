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

function deriveKey(password: string, salt: Buffer, parameters = options) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keyLength, parameters, (error, key) => {
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
  const parts = /^scrypt\$([1-9]\d*)\$([1-9]\d*)\$([1-9]\d*)\$([1-9]\d*)\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(storedHash ?? "");
  if (parts) {
    const [N, r, p, maxmem] = parts.slice(1, 5).map(Number);
    try {
      const key = await deriveKey(password, Buffer.from(parts[5], "hex"), { N, r, p, maxmem });
      return timingSafeEqual(key, Buffer.from(parts[6], "hex"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ERR_CRYPTO_INVALID_SCRYPT_PARAMS" && code !== "ERR_OUT_OF_RANGE") throw error;
    }
  }
  // Run scrypt for unknown accounts and invalid stored hashes as well.
  timingSafeEqual(await deriveKey(password, dummySalt), dummyKey);
  return false;
}
