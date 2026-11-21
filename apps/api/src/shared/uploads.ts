import { createHash, randomUUID } from "node:crypto";
import { constants, createWriteStream } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError } from "./errors.js";
import { isUuid } from "./uuid.js";

export const uploadLimits = { insurance: 10 * 1024 * 1024, pod: 5 * 1024 * 1024 } as const;
export type UploadKind = keyof typeof uploadLimits;

const signatures = [
  { mimeType: "application/pdf", bytes: Buffer.from("%PDF-") },
  { mimeType: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff]) },
  { mimeType: "image/png", bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
] as const;
const signatureLength = 8;

function unavailable(cause?: unknown) {
  return new AppError(503, "FILE_UNAVAILABLE", "The file is unavailable.", { cause });
}

function tooLarge() {
  return new AppError(413, "FILE_TOO_LARGE", "The file exceeds the permitted size.");
}

export function createUploadStorage(uploadDir: string) {
  function filePath(storageKey: string) {
    if (!isUuid(storageKey)) throw unavailable();
    return join(uploadDir, storageKey);
  }

  return {
    async save(kind: UploadKind, file: Readable & { truncated?: boolean }) {
      const storageKey = randomUUID();
      const stagedPath = join(uploadDir, `.${storageKey}.upload`);
      const hash = createHash("sha256");
      let sizeBytes = 0;
      let prefix = Buffer.alloc(0);
      const inspect = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          sizeBytes += chunk.length;
          if (sizeBytes > uploadLimits[kind]) return callback(tooLarge());
          if (prefix.length < signatureLength) {
            prefix = Buffer.concat([prefix, chunk.subarray(0, signatureLength - prefix.length)]);
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });

      try {
        await pipeline(file, inspect, createWriteStream(stagedPath, { flags: "wx", mode: 0o600 }));
        if (file.truncated) throw tooLarge();
        const mimeType = signatures.find(({ bytes }) => prefix.subarray(0, bytes.length).equals(bytes))?.mimeType;
        if (!mimeType || (kind === "pod" && mimeType === "application/pdf")) {
          throw new AppError(415, "UNSUPPORTED_FILE_TYPE", "The file type is unsupported.");
        }

        await rename(stagedPath, filePath(storageKey));
        return { storageKey, mimeType, sizeBytes, sha256: hash.digest("hex") };
      } catch (error) {
        await rm(stagedPath, { force: true }).catch(() => undefined);
        if (file.truncated) throw tooLarge();
        if (error instanceof AppError) throw error;
        throw unavailable(error);
      }
    },

    // The caller authorizes access and resolves the key from database metadata first.
    async open(storageKey: string) {
      try {
        const path = filePath(storageKey);
        if (!(await lstat(path)).isFile()) throw unavailable();
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          if (!(await handle.stat()).isFile()) throw unavailable();
          return handle.createReadStream();
        } catch (error) {
          await handle.close();
          throw error;
        }
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw unavailable(error);
      }
    },

    // Check database references before removing a saved file.
    async remove(storageKey: string) {
      try {
        await rm(filePath(storageKey), { force: true });
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw unavailable(error);
      }
    },
  };
}
