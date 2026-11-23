// Salted scrypt password hashes for credentials kept in config files.
//
// Format: scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
// The parameters travel with the hash, so the cost can be raised later without invalidating
// existing entries. A stolen config then yields a slow-to-test hash instead of a usable password.

import crypto from "crypto";

const DEFAULTS = { N: 16384, r: 8, p: 1, keylen: 32 };

function scryptAsync(secret: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions): Promise<Buffer> {
    // Async on purpose: the threadpool does the work, so a login never stalls the event loop
    // of the application serving payments in the same process.
    return new Promise((resolve, reject) =>
        crypto.scrypt(secret, salt, keylen, opts, (err, key) => err ? reject(err) : resolve(key as Buffer)));
}

export class PasswordHash {

    static isHash(value: unknown): boolean {
        return typeof value === "string" && value.startsWith("scrypt$");
    }

    static async hash(secret: string): Promise<string> {
        const { N, r, p, keylen } = DEFAULTS;
        const salt = crypto.randomBytes(16);
        const key = await scryptAsync(secret, salt, keylen, { N, r, p, maxmem: 256 * N * r });
        return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
    }

    /** Constant-time check of `secret` against a stored scrypt hash. Malformed hashes never match. */
    static async verify(secret: string, stored: string): Promise<boolean> {
        if (typeof secret !== "string" || !PasswordHash.isHash(stored)) return false;
        const parts = stored.split("$");
        if (parts.length !== 6) return false;
        const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
        // Bounds keep a hand-edited config from asking for gigabytes of memory per login.
        if (!Number.isInteger(N) || N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0) return false;
        if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
        let salt: Buffer, expected: Buffer;
        try {
            salt = Buffer.from(parts[4], "base64");
            expected = Buffer.from(parts[5], "base64");
        } catch { return false; }
        if (salt.length < 8 || expected.length < 16) return false;
        try {
            const key = await scryptAsync(secret, salt, expected.length, { N, r, p, maxmem: 256 * N * r });
            return crypto.timingSafeEqual(key, expected);
        } catch { return false; }
    }
}
