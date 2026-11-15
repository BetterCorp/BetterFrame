import { createHash, X509Certificate } from "node:crypto";

export const MAX_TRUSTED_CAS = 32;
export const MAX_CA_BYTES = 16 * 1024;
export interface TrustedCa {
  id: string;
  name: string;
  pem: string;
  fingerprint_sha256: string;
  subject: string;
  not_before: string;
  not_after: string;
}
export interface TrustedCaStatus {
  revision: string;
  state: "applied" | "pending" | "manual_action" | "error";
  message: string;
}
export type BundleTrustedCa = Pick<TrustedCa, "pem" | "fingerprint_sha256">;

/** Deliberately accept one public, self-signed root, never a private key or chain. */
export function parseTrustedCa(input: Uint8Array | string, now = Date.now()): Omit<TrustedCa, "id" | "name"> {
  const bytes = typeof input === "string" ? Buffer.from(input) : Buffer.from(input);
  if (!bytes.length || bytes.length > MAX_CA_BYTES) throw new Error("Certificate must be between 1 byte and 16 KiB");
  const text = bytes.toString("utf8").trim();
  if (text.includes("-----BEGIN")) {
    if (!/^-----BEGIN CERTIFICATE-----[\r\n]+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/.test(text)) {
      throw new Error("Upload one public CA certificate; private keys and certificate chains are not accepted");
    }
  }
  let cert: X509Certificate;
  try { cert = new X509Certificate(bytes); } catch { throw new Error("Invalid X.509 certificate (use PEM or DER)"); }
  if (!text.includes("-----BEGIN") && !cert.raw.equals(bytes)) throw new Error("Upload exactly one DER certificate");
  if (!cert.ca) throw new Error("Certificate must be a CA, not a website certificate");
  if (!cert.checkIssued(cert) || !cert.verify(cert.publicKey)) throw new Error("Certificate must be a self-signed root CA");
  const before = Date.parse(cert.validFrom), after = Date.parse(cert.validTo);
  if (!Number.isFinite(before) || !Number.isFinite(after) || now < before || now >= after) {
    throw new Error("CA certificate is expired or not yet valid");
  }
  const pem = cert.toString();
  if (Buffer.byteLength(pem) > MAX_CA_BYTES) throw new Error("Canonical PEM certificate exceeds 16 KiB");
  return { pem, fingerprint_sha256: createHash("sha256").update(cert.raw).digest("hex"),
    subject: cert.subject, not_before: new Date(before).toISOString(), not_after: new Date(after).toISOString() };
}

/** Hash only the ordered fingerprints: consistent across every client implementation. */
export function trustedCaRevision(cas: readonly BundleTrustedCa[]): string {
  return createHash("sha256").update(cas.map(ca => ca.fingerprint_sha256).sort().join("\n")).digest("hex");
}

export function activeTrustedCas(cas: readonly TrustedCa[], now = Date.now()): TrustedCa[] {
  return cas.filter(ca => Date.parse(ca.not_before) <= now && now < Date.parse(ca.not_after));
}

export function trustedCaAssignment(value: unknown): string[] {
  const ids = value == null || value === "" ? [] : Array.isArray(value) ? value : [value];
  if (ids.length > MAX_TRUSTED_CAS || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(id))) {
    throw new Error("Select at most 32 valid CA certificates");
  }
  return [...new Set(ids as string[])].sort();
}
