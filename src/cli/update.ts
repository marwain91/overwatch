import * as path from 'path';
import { execSync } from 'child_process';
import { findDeployDir } from './lifecycle';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

function exec(cmd: string): string {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' }).trim();
}

export async function runUpdate(args: string[]): Promise<void> {
  const checkOnly = args.includes('--check');

  const composeDir = path.join(findDeployDir(), 'overwatch');
  const serviceName = process.env.SERVICE_NAME || 'overwatch';
  const image = process.env.IMAGE || 'ghcr.io/marwain91/overwatch:latest';

  console.log(`${GREEN}Overwatch Update${NC}`);
  console.log('================');
  console.log('');

  // Get current local digest
  console.log('Checking current version...');
  let currentDigest: string;
  try {
    currentDigest = exec(`docker inspect --format='{{index .RepoDigests 0}}' "${image}"`);
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
      // docker buildx imagetools inspect prints "Digest: sha256:..." without pulling layers
      const output = exec(`docker buildx imagetools inspect "${image}" 2>/dev/null`);
      const match = output.match(/Digest:\s+(sha256:[a-f0-9]+)/);
      if (match) {
        const imageBase = image.split('@')[0].split(':')[0];
        remoteDigest = `${imageBase}@${match[1]}`;
      }
    } catch {
      try {
        // Fallback: docker manifest inspect (requires experimental on older Docker)
        const output = exec(`docker manifest inspect "${image}" 2>/dev/null`);
        const parsed = JSON.parse(output);
        const digest = parsed.config?.digest || parsed.manifests?.[0]?.digest;
        if (digest) {
          const imageBase = image.split('@')[0].split(':')[0];
          remoteDigest = `${imageBase}@${digest}`;
        }
      } catch {
        console.log('Could not check remote digest without pulling.');
        console.log('Run without --check to pull and update.');
        return;
      }
    }
    console.log(`Remote:  ${remoteDigest}`);

    // Compare the sha256 hash portion only
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
  console.log('Pulling latest image...');
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

  console.log('');
  console.log(`${YELLOW}Update available!${NC}`);
  console.log('');
  console.log('Applying update...');
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
