import { execSync } from 'child_process';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const NC = '\x1b[0m';

function exec(cmd: string): string {
  return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' }).trim();
}

export async function runUpdate(args: string[]): Promise<void> {
  const checkOnly = args.includes('--check');

  const composeDir = process.env.COMPOSE_DIR || process.cwd();
  const serviceName = process.env.SERVICE_NAME || 'overwatch';
  const image = process.env.IMAGE || 'ghcr.io/marwain91/overwatch:latest';

  console.log(`${GREEN}Overwatch Update${NC}`);
  console.log('================');
  console.log('');

  // Get current digest
  console.log('Checking current version...');
  let currentDigest: string;
  try {
    currentDigest = exec(`docker inspect --format='{{index .RepoDigests 0}}' "${image}"`);
  } catch {
    currentDigest = 'none';
  }
  console.log(`Current: ${currentDigest}`);

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

  if (checkOnly) {
    console.log('Run without --check to apply the update.');
    return;
  }

  // Apply
  console.log('');
  console.log('Applying update...');
  execSync(`docker compose up -d "${serviceName}"`, { stdio: 'inherit', cwd: composeDir });

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
