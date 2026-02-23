import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { findDeployDir } from './lifecycle';
import { runSelfUpdate } from './self-update';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

function exec(cmd: string): string {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' }).trim();
}

/**
 * Read the current image reference from docker-compose.yml for the given service.
 */
function readComposeImage(composeDir: string, serviceName: string): string | null {
  const composePath = path.join(composeDir, 'docker-compose.yml');
  try {
    const content = fs.readFileSync(composePath, 'utf-8');
    // Match "image: ..." under the service definition
    const serviceRegex = new RegExp(`${serviceName}:[\\s\\S]*?image:\\s*([^\\s#]+)`, 'm');
    const match = content.match(serviceRegex);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Update the image reference in docker-compose.yml.
 * Falls back to retagging the image locally if the file can't be written (e.g., owned by root).
 */
function updateComposeImage(composeDir: string, oldImage: string, newImage: string): boolean {
  const composePath = path.join(composeDir, 'docker-compose.yml');
  try {
    const content = fs.readFileSync(composePath, 'utf-8');
    const updated = content.replace(oldImage, newImage);
    fs.writeFileSync(composePath, updated);
    return true;
  } catch {
    // Permission denied — retag the pulled image to match the compose file's tag instead
    console.log(`Cannot write compose file, retagging image instead...`);
    execSync(`docker tag "${newImage}" "${oldImage}"`, { stdio: 'pipe' });
    return false;
  }
}

export async function runUpdate(args: string[]): Promise<void> {
  const checkOnly = args.includes('--check');

  // Self-update CLI binary if requested
  if (args.includes('--self-update')) {
    try {
      await runSelfUpdate(args);
    } catch (err: any) {
      console.log(`  ${YELLOW}!${NC} CLI self-update skipped: ${err.message}`);
      console.log('');
    }
  }

  const composeDir = path.join(findDeployDir(), 'overwatch');
  const serviceName = process.env.SERVICE_NAME || 'overwatch';

  // Determine image: explicit IMAGE env, or read from compose file, or default to latest
  const composeImage = readComposeImage(composeDir, serviceName);
  const imageBase = composeImage
    ? composeImage.split(':')[0].split('@')[0]
    : 'ghcr.io/marwain91/overwatch';
  const image = process.env.IMAGE || `${imageBase}:latest`;

  console.log(`${GREEN}Overwatch Update${NC}`);
  console.log('================');
  console.log('');

  if (composeImage) {
    console.log(`Compose image: ${composeImage}`);
  }

  // Get current local digest
  console.log('Checking current version...');
  let currentDigest: string;
  try {
    currentDigest = exec(`docker inspect --format='{{index .RepoDigests 0}}' "${composeImage || image}"`);
  } catch {
    currentDigest = 'none';
  }
  console.log(`Current: ${currentDigest}`);

  if (checkOnly) {
    // Fetch remote digest without pulling image layers
    console.log('');
    console.log('Checking remote registry...');
    let remoteDigest = 'unknown';
    try {
      const output = exec(`docker buildx imagetools inspect "${image}" 2>/dev/null`);
      const match = output.match(/Digest:\s+(sha256:[a-f0-9]+)/);
      if (match) {
        remoteDigest = `${imageBase}@${match[1]}`;
      }
    } catch {
      try {
        const output = exec(`docker manifest inspect "${image}" 2>/dev/null`);
        const parsed = JSON.parse(output);
        const digest = parsed.config?.digest || parsed.manifests?.[0]?.digest;
        if (digest) {
          remoteDigest = `${imageBase}@${digest}`;
        }
      } catch {
        console.log('Could not check remote digest without pulling.');
        console.log('Run without --check to pull and update.');
        return;
      }
    }
    console.log(`Remote:  ${remoteDigest}`);

    const localHash = currentDigest.match(/sha256:[a-f0-9]+/)?.[0] || currentDigest;
    const remoteHash = remoteDigest.match(/sha256:[a-f0-9]+/)?.[0] || remoteDigest;

    if (localHash === remoteHash) {
      console.log('');
      console.log(`${GREEN}Already up to date!${NC}`);
    } else {
      console.log('');
      console.log(`${YELLOW}Update available!${NC}`);
      console.log('Run without --check to apply the update.');
    }
    return;
  }

  // Pull latest
  console.log('');
  console.log(`Pulling ${image}...`);
  execSync(`docker pull "${image}"`, { stdio: 'inherit' });

  // Get new digest
  let newDigest: string;
  try {
    newDigest = exec(`docker inspect --format='{{index .RepoDigests 0}}' "${image}"`);
  } catch {
    newDigest = 'none';
  }
  console.log(`Latest:  ${newDigest}`);

  // Compare
  if (currentDigest === newDigest) {
    console.log('');
    console.log(`${GREEN}Already up to date!${NC}`);
    return;
  }

  // Update docker-compose.yml to use the pulled image tag
  if (composeImage && composeImage !== image) {
    console.log(`Updating compose image: ${composeImage} -> ${image}`);
    updateComposeImage(composeDir, composeImage, image);
  }

  console.log('');
  console.log(`${YELLOW}Update found!${NC} Applying...`);
  execSync(`docker compose up -d --force-recreate "${serviceName}"`, { stdio: 'inherit', cwd: composeDir });

  console.log('');
  console.log(`${GREEN}Update complete!${NC}`);
  console.log('');

  // Wait and show status
  await new Promise(resolve => setTimeout(resolve, 3000));
  console.log('Container status:');
  execSync(
    `docker ps --filter "name=${serviceName}" --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}"`,
    { stdio: 'inherit' },
  );
}
