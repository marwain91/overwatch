import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { VERSION } from '../version';

const MAX_REDIRECTS = 5;

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const NC = '\x1b[0m';

const REPO = 'marwain91/overwatch';

interface GitHubRelease {
  tag_name: string;
  assets: Array<{
    name: string;
    browser_download_url: string;
    size: number;
  }>;
}

function getAssetName(): string {
  const arch = os.arch();
  if (arch === 'x64') return 'overwatch-linux-x64';
  if (arch === 'arm64') return 'overwatch-linux-arm64';
  throw new Error(`Unsupported architecture: ${arch}. Only x64 and arm64 are supported.`);
}

function getBinaryPath(): string {
  // For pkg binaries, process.execPath is the binary itself
  // For node, we need the symlink/script that invoked us
  const execPath = process.execPath;
  // If running as a pkg binary, execPath is the binary
  if (!execPath.includes('node') && !execPath.includes('Node')) {
    return execPath;
  }
  // Running via node — try to find the symlink
  const argv1 = process.argv[1];
  if (argv1) {
    try {
      return fs.realpathSync(argv1);
    } catch {
      return argv1;
    }
  }
  throw new Error('Cannot determine binary path. Self-update only works with the compiled binary.');
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

function fetchJSON(url: string, redirectsLeft: number = MAX_REDIRECTS): Promise<GitHubRelease> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': `overwatch-cli/${VERSION}`,
        'Accept': 'application/vnd.github+json',
      },
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        if (redirectsLeft <= 0) {
          reject(new Error('Too many redirects while fetching release metadata'));
          return;
        }
        const location = res.headers.location;
        if (location) {
          fetchJSON(location, redirectsLeft - 1).then(resolve, reject);
          return;
        }
      }

      if (res.statusCode !== 200) {
        reject(new Error(`GitHub API returned ${res.statusCode}`));
        return;
      }

      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse GitHub API response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error('GitHub API request timed out'));
    });
  });
}

/** Download a small text resource (checksum file) following bounded redirects. */
function fetchText(url: string, redirectsLeft: number = MAX_REDIRECTS): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': `overwatch-cli/${VERSION}` } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects fetching checksum'));
        const location = res.headers.location;
        if (location) return fetchText(location, redirectsLeft - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`Checksum download returned ${res.statusCode}`));
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Checksum download timed out')); });
  });
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function downloadFile(url: string, dest: string, totalSize: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let redirectsLeft = MAX_REDIRECTS;
    const doDownload = (downloadUrl: string) => {
      const req = https.get(downloadUrl, {
        headers: { 'User-Agent': `overwatch-cli/${VERSION}` },
      }, (res) => {
        // Follow redirects (bounded).
        if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
          if (--redirectsLeft < 0) {
            reject(new Error('Too many redirects while downloading binary'));
            return;
          }
          const location = res.headers.location;
          if (location) {
            doDownload(location);
            return;
          }
        }

        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }

        const file = fs.createWriteStream(dest);
        let downloaded = 0;

        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          file.write(chunk);
          if (totalSize > 0) {
            const pct = Math.round((downloaded / totalSize) * 100);
            process.stdout.write(`\r  Downloading... ${pct}%`);
          }
        });

        res.on('end', () => {
          file.end();
          process.stdout.write('\r  Downloading... done\n');
          file.on('finish', resolve);
        });

        res.on('error', (err) => {
          file.close();
          fs.unlinkSync(dest);
          reject(err);
        });
      });

      req.on('error', reject);
      req.setTimeout(120000, () => {
        req.destroy();
        reject(new Error('Download timed out'));
      });
    };

    doDownload(url);
  });
}

function wantsHelp(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function showSelfUpdateHelp(): void {
  console.log('');
  console.log(`  ${BOLD}overwatch self-update${NC}`);
  console.log('');
  console.log('  Update the Overwatch CLI binary from the latest GitHub release.');
  console.log('');
  console.log('  Usage: overwatch self-update [options]');
  console.log('');
  console.log('  Options:');
  console.log('    --check                 Check for an available CLI update without installing it');
  console.log('    -h, --help              Show this help');
  console.log('');
}

export async function runSelfUpdate(args: string[]): Promise<void> {
  if (wantsHelp(args)) {
    showSelfUpdateHelp();
    return;
  }

  const checkOnly = args.includes('--check');
  const platform = os.platform();

  console.log(`${BOLD}Overwatch Self-Update${NC}`);
  console.log('');

  console.log(`  Current version: ${BOLD}${VERSION}${NC}`);

  if (platform !== 'linux') {
    console.log('');
    console.log(`  ${YELLOW}!${NC} Self-update is only available for Linux binaries.`);
    console.log(`  ${DIM}Install from source or use your package manager to update.${NC}`);
    return;
  }

  // Check binary path and write permissions early (before network request)
  let binaryPath: string;
  try {
    binaryPath = getBinaryPath();
  } catch (err: any) {
    throw new Error(err.message);
  }

  if (!checkOnly) {
    const binaryDir = path.dirname(binaryPath);
    try {
      fs.accessSync(binaryDir, fs.constants.W_OK);
    } catch {
      throw new Error(
        `Cannot write to ${binaryDir}\n` +
        `  Try: sudo overwatch self-update`
      );
    }
  }

  console.log(`  ${DIM}Binary: ${binaryPath}${NC}`);

  // Fetch latest release
  console.log(`  ${DIM}Checking for updates...${NC}`);

  let release: GitHubRelease;
  try {
    release = await fetchJSON(`https://api.github.com/repos/${REPO}/releases/latest`);
  } catch (err: any) {
    throw new Error(`Failed to check for updates: ${err.message}`);
  }

  const latestVersion = release.tag_name.replace(/^v/, '');
  console.log(`  Latest version:  ${BOLD}${latestVersion}${NC}`);
  console.log('');

  const cmp = compareVersions(latestVersion, VERSION);
  if (cmp <= 0) {
    console.log(`  ${GREEN}✓${NC} Already up to date!`);
    console.log('');
    return;
  }

  console.log(`  ${YELLOW}!${NC} Update available: ${VERSION} -> ${latestVersion}`);

  if (checkOnly) {
    console.log(`  ${DIM}Run "overwatch self-update" to apply.${NC}`);
    console.log('');
    return;
  }

  // Find the right asset
  let assetName: string;
  try {
    assetName = getAssetName();
  } catch (err: any) {
    throw new Error(err.message);
  }

  const asset = release.assets.find(a => a.name === assetName);
  if (!asset) {
    throw new Error(
      `No binary found for ${assetName} in release ${release.tag_name}.\n` +
      `  Available: ${release.assets.map(a => a.name).join(', ') || 'none'}`
    );
  }

  // SHA256 integrity check. We require a companion `<asset>.sha256` asset in
  // every release; refuse to install if it's missing or the hash differs.
  // TLS alone is not enough — it proves the bytes came from GitHub, not that
  // they are the bytes a maintainer intended to publish.
  const shaAsset = release.assets.find(a => a.name === `${assetName}.sha256`);
  if (!shaAsset) {
    const skip = process.env.OVERWATCH_SKIP_CHECKSUM === '1';
    if (!skip) {
      throw new Error(
        `No checksum (${assetName}.sha256) found in release ${release.tag_name}. ` +
        `Refusing to install an unverified binary. Set OVERWATCH_SKIP_CHECKSUM=1 to override (not recommended).`
      );
    }
    console.log(`  ${YELLOW}!${NC} OVERWATCH_SKIP_CHECKSUM=1 — skipping integrity check`);
  }

  // Lockfile prevents two concurrent self-updates from racing on the binary path.
  const lockPath = `${binaryPath}.lock`;
  let lockFd: number | null = null;
  try {
    lockFd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeSync(lockFd, `${process.pid}\n`);
  } catch (err: any) {
    if (err.code === 'EEXIST') {
      throw new Error(
        `Another self-update is in progress (lockfile at ${lockPath}).\n` +
        `  If no update is running, remove the lockfile and retry.`
      );
    }
    throw new Error(`Failed to acquire self-update lock: ${err.message}`);
  }

  // Download to temp file in same directory (for atomic rename)
  const tmpPath = `${binaryPath}.tmp`;

  try {
    await downloadFile(asset.browser_download_url, tmpPath, asset.size);

    // Verify SHA256 before promoting the tmp file. On mismatch: delete and abort.
    if (shaAsset) {
      const expectedLine = await fetchText(shaAsset.browser_download_url);
      // Checksum files typically look like: "<hex>  <filename>". Take the first hex token.
      const expected = (expectedLine.trim().split(/\s+/)[0] || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(expected)) {
        throw new Error(`Checksum asset ${shaAsset.name} did not contain a valid SHA256`);
      }
      const actual = (await sha256File(tmpPath)).toLowerCase();
      if (actual !== expected) {
        throw new Error(
          `SHA256 mismatch for ${assetName}:\n  expected ${expected}\n  actual   ${actual}\n` +
          `Refusing to install. If you trust this release, re-publish with a matching ${assetName}.sha256.`
        );
      }
      console.log(`  ${GREEN}✓${NC} SHA256 verified`);
    }

    // Make executable
    fs.chmodSync(tmpPath, 0o755);

    // Atomic replace — realpath the target first to resolve any symlinks, so a
    // symlinked `overwatch` in a user-writable dir can't redirect the rename.
    let resolvedBinary = binaryPath;
    try { resolvedBinary = fs.realpathSync(binaryPath); } catch { /* not a symlink */ }
    fs.renameSync(tmpPath, resolvedBinary);

    console.log('');
    console.log(`  ${GREEN}✓${NC} Updated to ${BOLD}${latestVersion}${NC}`);
    console.log('');
  } catch (err: any) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch {}
    throw new Error(`Update failed: ${err.message}`);
  } finally {
    if (lockFd !== null) {
      try { fs.closeSync(lockFd); } catch {}
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}
