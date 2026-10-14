import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AppDefinition } from '../models/app';

const execFileAsync = promisify(execFile);

// A manifest is a small JSON app definition; anything larger is not one, and the
// image is not trusted to keep Overwatch from reading an arbitrarily large file.
const MAX_MANIFEST_BYTES = 1024 * 1024;

/**
 * Extract a single file from a Docker image without running it. Creates a
 * throw-away container (which starts no process), `docker cp`s the file out,
 * removes the container. Returns the file contents as a string, or `null`
 * if the file doesn't exist inside the image.
 *
 * Failures other than "file not found" throw — they usually mean the image
 * can't be resolved, docker isn't reachable, or the path is malformed.
 */
export async function extractFileFromImage(
  imageRef: string,
  pathInImage: string,
): Promise<string | null> {
  try {
    await execFileAsync('docker', ['image', 'inspect', imageRef]);
  } catch {
    // Image not locally present — pull it.
    await execFileAsync('docker', ['pull', imageRef]);
  }

  // A private directory, so nothing else can pre-create or swap the target path.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ow-manifest-'));
  let cid: string | undefined;
  try {
    const { stdout: createOut } = await execFileAsync('docker', ['create', imageRef]);
    cid = createOut.trim();
    const tmpFile = path.join(tmpDir, 'manifest.json');
    try {
      await execFileAsync('docker', ['cp', `${cid}:${pathInImage}`, tmpFile]);
    } catch (err: any) {
      const msg = `${err?.stderr || ''} ${err?.message || ''}`;
      if (/no such file|could not find|not found|does not exist/i.test(msg)) {
        return null;
      }
      throw err;
    }
    // `docker cp` copies a symlink as a symlink; following it would read a file
    // of Overwatch's own choosing (or /dev/zero past the size check). Only a
    // regular file within the limit counts as a manifest. O_NONBLOCK keeps a
    // FIFO from blocking the open; it is then rejected as not a regular file.
    let handle: fs.FileHandle;
    try {
      handle = await fs.open(tmpFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    } catch (err: any) {
      if (err?.code === 'ELOOP' || err?.code === 'EISDIR') {
        console.warn(`[manifest] ${pathInImage} in ${imageRef} is not a regular file; ignoring it`);
        return null;
      }
      throw err;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) {
        console.warn(`[manifest] ${pathInImage} in ${imageRef} is not a regular file; ignoring it`);
        return null;
      }
      if (st.size > MAX_MANIFEST_BYTES) {
        console.warn(`[manifest] ${pathInImage} in ${imageRef} is ${st.size} bytes (limit ${MAX_MANIFEST_BYTES}); ignoring it`);
        return null;
      }
      return await handle.readFile('utf-8');
    } finally {
      await handle.close().catch(() => {});
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    if (cid) await execFileAsync('docker', ['rm', '-f', cid]).catch(() => {});
  }
}

/**
 * Compute the full image reference (registry/repository/suffix:tag) for the
 * service designated as the manifest source. Returns null when the app has no
 * matching service — caller should skip manifest sync.
 */
export function resolveManifestImageRef(app: AppDefinition, imageTag: string): string | null {
  const cfg = app.manifest;
  const wantedSuffix = cfg?.image_suffix ?? 'backend';
  const service = app.services.find(s => s.image_suffix === wantedSuffix);
  if (!service || !service.image_suffix) return null;
  return `${app.registry.url}/${app.registry.repository}/${service.image_suffix}:${imageTag}`;
}

export function resolveManifestPathInImage(app: AppDefinition): string {
  return app.manifest?.path ?? '/overwatch/app.json';
}

/**
 * Fetch and return the app definition embedded in an app's new-image,
 * if any. Returns:
 *   - parsed JSON object when an `app.json` is found,
 *   - `null` when the app isn't configured for manifest sync OR the image
 *     carries no manifest (neither is an error — operator may have opted out),
 *   - throws only on unrecoverable failures (docker unreachable, invalid JSON).
 */
export async function readManifestFromAppImage(
  app: AppDefinition,
  imageTag: string,
): Promise<unknown | null> {
  const imageRef = resolveManifestImageRef(app, imageTag);
  if (!imageRef) return null;
  const pathInImage = resolveManifestPathInImage(app);
  const raw = await extractFileFromImage(imageRef, pathInImage);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // The parser's message quotes the input; keep file content out of errors and logs.
    throw new Error(`Manifest at ${imageRef}:${pathInImage} is not valid JSON`);
  }
}
