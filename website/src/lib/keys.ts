// Keys, tokens and password hashes for the config generator — made in this browser tab and never sent
// anywhere (the page's Content-Security-Policy blocks every connection).
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { scryptHash, toBase64 } from "../../../packages/api/src/apiServer/deployment/ConfigRules";

export const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const randomHex = (n: number) => Array.from(randomBytes(n), b => b.toString(16).padStart(2, "0")).join("");

/** PasswordHash-compatible: scrypt$16384$8$1$<salt>$<hash>. Takes about a second. */
export const hashSecret = (secret: string) =>
    scryptHash((pw, salt, o) => scryptAsync(pw, salt, o), secret, randomBytes(16));

const fromBase64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = (s: string) => fromBase64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - s.length % 4) % 4));
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the 32-byte key follows.
const SPKI_ED25519 = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

export const ed25519Supported = async () => {
    try { await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]); return true; } catch { return false; }
};

/** A signing key pair, base64 DER like `bmfk deploy-key`: private PKCS#8 for deploy.json, public SPKI for setup.json. */
export async function ed25519Pair(): Promise<{ privateKey: string, publicKey: string }> {
    const k = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
    return {
        privateKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("pkcs8", k.privateKey))),
        publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", k.publicKey))),
    };
}

/** The public key of a pasted private key (base64 PKCS#8); null when it isn't an Ed25519 key. */
export async function publicKeyOf(privateKey: string): Promise<string | null> {
    try {
        const key = await crypto.subtle.importKey("pkcs8", fromBase64(privateKey.trim()), { name: "Ed25519" }, true, ["sign"]);
        const jwk = await crypto.subtle.exportKey("jwk", key);
        const x = b64url(String(jwk.x));
        if (x.length !== 32) return null;
        const spki = new Uint8Array(SPKI_ED25519.length + 32);
        spki.set(SPKI_ED25519);
        spki.set(x, SPKI_ED25519.length);
        return toBase64(spki);
    } catch { return null; }
}

/** A public key pasted from `bmfk deploy-key`: base64 SPKI of an Ed25519 key. */
export function isPublicKey(s: string): boolean {
    try {
        const der = fromBase64(s.trim());
        return der.length === 44 && SPKI_ED25519.every((b, i) => der[i] === b);
    } catch { return false; }
}
