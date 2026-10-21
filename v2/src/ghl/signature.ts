import crypto from "node:crypto";

/**
 * GHL signs every webhook with Ed25519 over the raw body, in the X-GHL-Signature header (base64). The public key is GHL's,
 * published in its webhook docs, and is set as GHL_WEBHOOK_PUBLIC_KEY (PEM). The older RSA X-WH-Signature is not accepted.
 */
export function verifyGhlSignature(rawBody: string, signature: string | null, publicKeyPem: string): boolean {
  if (!signature) return false;
  try {
    return crypto.verify(null, Buffer.from(rawBody, "utf8"), crypto.createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
