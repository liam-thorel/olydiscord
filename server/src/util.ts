import { createHash, randomBytes } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Identifiant aléatoire base62 (12 caractères ≈ 71 bits : impossible à deviner) */
export function randomId(length = 12): string {
  const bytes = randomBytes(length * 2);
  let out = "";
  for (let i = 0; out.length < length && i < bytes.length; i++) {
    // rejette les octets ≥ 248 pour éviter le biais du modulo
    if (bytes[i] < 248) out += ALPHABET[bytes[i] % 62];
  }
  return out.length === length ? out : randomId(length);
}

export const randomToken = () => randomBytes(32).toString("base64url");

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export const httpError = (status: number, message: string) => new HttpError(status, message);

export function formatBytes(n: number): string {
  const units = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Nom de fichier sûr pour l'affichage et Content-Disposition */
export function sanitizeName(name: string): string {
  const clean = name.replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200);
  return clean || "fichier";
}
