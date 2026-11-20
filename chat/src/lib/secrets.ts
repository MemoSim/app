import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Encrypts user API keys at rest (AES-256-GCM). The key comes from SETTINGS_SECRET, or, when unset, from a random
 * file created next to the database (mode 0600). Losing the key makes stored API keys unreadable (users re-enter them).
 */
let cachedKey: Buffer | null = null;

function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.SETTINGS_SECRET;
  if (fromEnv && fromEnv.length >= 16) {
    cachedKey = createHash("sha256").update(fromEnv).digest();
    return cachedKey;
  }
  const dbPath = path.resolve(process.env.DATABASE_PATH ?? "./data/app.db");
  const file = path.join(path.dirname(dbPath), ".settings-key");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    cachedKey = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64");
  } else {
    cachedKey = randomBytes(32);
    fs.writeFileSync(file, cachedKey.toString("base64"), { mode: 0o600 });
  }
  return cachedKey;
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", masterKey(), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64"), c.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

/** Returns null when the value cannot be decrypted (wrong/lost master key or tampering). */
export function decryptSecret(stored: string): string | null {
  try {
    const [v, iv, tag, ct] = stored.split(":");
    if (v !== "v1" || !iv || !tag || !ct) return null;
    const d = createDecipheriv("aes-256-gcm", masterKey(), Buffer.from(iv, "base64"));
    d.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/** For display: never reveals more than the last 4 characters. */
export function keyHint(key: string): string {
  return key.length <= 8 ? "••••" : `••••${key.slice(-4)}`;
}

/** Test hook. */
export function _resetSecretsCache(): void {
  cachedKey = null;
}
