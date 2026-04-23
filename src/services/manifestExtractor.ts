import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AppDefinition } from '../models/app';

const execFileAsync = promisify(execFile);

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

  const { stdout: createOut } = await execFileAsync('docker', ['create', imageRef]);
  const cid = createOut.trim();

  try {
    const tmpFile = path.join(os.tmpdir(), `ow-manifest-${process.pid}-${Date.now()}.json`);
    try {
      await execFileAsync('docker', ['cp', `${cid}:${pathInImage}`, tmpFile]);
    } catch (err: any) {
      const msg = `${err?.stderr || ''} ${err?.message || ''}`;
      if (/no such file|could not find|not found|does not exist/i.test(msg)) {
        return null;
      }
      throw err;
    }
    const content = await fs.readFile(tmpFile, 'utf-8');
    await fs.unlink(tmpFile).catch(() => {});
    return content;
  } finally {
    await execFileAsync('docker', ['rm', '-f', cid]).catch(() => {});
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
  } catch (err: any) {
    throw new Error(
      `Manifest at ${imageRef}:${pathInImage} is not valid JSON: ${err?.message || err}`
    );
  }
}
