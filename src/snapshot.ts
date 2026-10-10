import { mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";

export interface SnapshotOptions {
  snapshotDir?: string;
  name?: string;
  timestamp?: number;
}

/**
 * Saves HTML content to a snapshot file for post-incident debugging.
 * Returns the absolute path to the saved file.
 */
export async function saveSnapshot(
  html: string,
  options: SnapshotOptions = {}
): Promise<string> {
  const dir = resolve(process.cwd(), options.snapshotDir || ".snapshots");
  await mkdir(dir, { recursive: true });

  const ts = options.timestamp || Date.now();
  const safeName = (options.name || "target")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const filename = `drift-${ts}-${safeName || "snapshot"}.html`;
  const filePath = join(dir, filename);

  await Bun.write(filePath, html);
  return filePath;
}
