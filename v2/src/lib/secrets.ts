import crypto from "node:crypto";

/**
 * Tokens at rest: AES-256-GCM under TOKEN_KEY (32 bytes, base64), which lives only in the host's environment, never in the
 * database. The stored form is iv.tag.ciphertext, each base64.
 */
function key(): Buffer {
  const k = Buffer.from(process.env.TOKEN_KEY ?? "", "base64");
  if (k.length !== 32) throw new Error("TOKEN_KEY must be 32 bytes, base64");
  return k;
}

export function seal(plain: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function open(sealed: string): string {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64"));
  if (!iv || !tag || !data) throw new Error("not a sealed value");
  const d = crypto.createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}
