import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Untouched source originals at <root>/<ticker>/<accession>/<filename> (§8, §12). Write-once:
 * an amended document with new bytes gets the hash in its filename instead of overwriting.
 */
export class RawStore {
  constructor(private readonly root: string) {}

  async store(ticker: string, externalId: string, filename: string, bytes: Buffer): Promise<string> {
    const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_");
    const dir = path.join(safe(ticker), safe(externalId));
    let rel = path.join(dir, safe(filename));
    const abs = path.join(this.root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    try {
      const existing = await fs.readFile(abs);
      if (sha256(existing) === sha256(bytes)) return toPosix(rel);
      const ext = path.extname(filename);
      rel = path.join(dir, `${safe(path.basename(filename, ext))}.${sha256(bytes).slice(0, 12)}${ext}`);
    } catch {
      // not there yet
    }
    await fs.writeFile(path.join(this.root, rel), bytes, { flag: "w" });
    return toPosix(rel);
  }

  async read(relPath: string): Promise<Buffer> {
    return fs.readFile(path.join(this.root, relPath));
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
