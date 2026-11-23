import * as fs from 'fs/promises';
import { constants as fsConstants } from 'fs';

/**
 * Read a regular file without following symlinks: lstat must say regular
 * file, the open uses O_NOFOLLOW, and the opened inode must be the one lstat
 * saw (a swap in between is caught). Null when it is a symlink or not a
 * regular file. Callers often run as root, so following a link would read any
 * file on the host.
 */
export async function readRegularFile(file: string): Promise<{ data: Buffer; mode: number } | null> {
  const before = await fs.lstat(file);
  if (!before.isFile()) return null;
  let fh: fs.FileHandle;
  try {
    // O_NONBLOCK: a FIFO swapped in after the lstat must not hang the open.
    fh = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err: any) {
    if (err.code === 'ELOOP') return null;
    throw err;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino) return null;
    return { data: await fh.readFile(), mode: st.mode & 0o777 };
  } finally {
    await fh.close();
  }
}
