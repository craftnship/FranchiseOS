import { randomUUID } from "crypto";

// Uploaded documents live in Catalyst Stratus. Records keep a `stratus:<key>` reference; people
// download through a short-lived signed URL, so a bucket never needs to be public.

export interface FileStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  /** A link that downloads the object for a few minutes. */
  downloadUrl(key: string): Promise<string>;
}

export const STRATUS_PREFIX = "stratus:";
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const UPLOAD_TYPES: Record<string, string> = {
  "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};

/** Keeps letters, digits, dot, dash and underscore so the key is valid and readable. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const clean = base.normalize("NFKD").replace(/[^\w.-]+/g, "_").replace(/_+/g, "_").replace(/^[._]+/, "").slice(-100);
  return clean || "file";
}

/** tenants/<tenant>/applications/<application>/<random>/<file name> */
export function documentKey(tenantId: string, applicationId: string, fileName: string): string {
  return `tenants/${tenantId}/applications/${applicationId}/${randomUUID()}/${safeFileName(fileName)}`;
}

/** The original file name, read back from the key. */
export const fileNameOf = (ref: string) => ref.split("/").pop() ?? ref;

/** The slice of zcatalyst-sdk-node 3.x `stratus().bucket(name)` used here. */
interface StratusBucket {
  putObject(key: string, body: Buffer, options?: { contentType?: string; overwrite?: boolean }): Promise<unknown>;
  generatePreSignedUrl(key: string, action: "GET" | "PUT", options?: { expiryIn?: string }): Promise<{ signature?: string } | Record<string, unknown>>;
}

export class StratusFileStorage implements FileStorage {
  constructor(private readonly bucket: StratusBucket, private readonly expirySeconds = 300) {}

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    await this.bucket.putObject(key, data, { contentType });
  }

  async downloadUrl(key: string): Promise<string> {
    const res = (await this.bucket.generatePreSignedUrl(key, "GET", { expiryIn: String(this.expirySeconds) })) as Record<string, unknown>;
    const url = (res.signature ?? (res.data as Record<string, unknown> | undefined)?.signature) as string | undefined;
    if (!url) throw new Error("Stratus returned no signed URL");
    return url;
  }
}

/** In-memory storage for tests and the local preview. */
export class MemoryFileStorage implements FileStorage {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();
  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    if (this.objects.has(key)) throw new Error("key_already_exists");
    this.objects.set(key, { data, contentType });
  }
  async downloadUrl(key: string): Promise<string> {
    if (!this.objects.has(key)) throw new Error("not found");
    return `memory://${key}`;
  }
}
