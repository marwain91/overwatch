import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { loadConfig, OverwatchConfig } from './config';
import { loginToRegistry } from './adapters/registry';
import { authMiddleware } from './middleware/auth';
import tenantsRouter from './routes/tenants';
import statusRouter from './routes/status';
import authRouter from './routes/auth';
import adminUsersRouter from './routes/adminUsers';
import backupsRouter from './routes/backups';
import envVarsRouter from './routes/envVars';
import { regenerateAllSharedEnvFiles } from './services/envVars';

// Load environment variables
dotenv.config();

// Validate configuration early
let config: OverwatchConfig;
try {
  config = loadConfig();
  console.log(`Overwatch configured for project: ${config.project.name}`);
} catch (error: any) {
  console.error('Configuration error:', error.message);
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3002;
const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error('JWT_SECRET environment variable is required');
  process.exit(1);
}

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Health check (no auth)
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    project: config.project.name,
    timestamp: new Date().toISOString(),
    buildTime: process.env.BUILD_TIME || 'dev',
    buildCommit: process.env.BUILD_COMMIT || 'dev',
  });
});

// Auth routes (no auth required)
app.use('/api/auth', authRouter);

// API routes (with auth)
app.use('/api/tenants', authMiddleware, tenantsRouter);
app.use('/api/admin-users', authMiddleware, adminUsersRouter);
app.use('/api/status', authMiddleware, statusRouter);
app.use('/api/backups', authMiddleware, backupsRouter);
app.use('/api/env-vars', authMiddleware, envVarsRouter);

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// Initialize and start server
async function start() {
  // Login to container registry for pulling tenant images
  try {
    await loginToRegistry();
  } catch (error) {
    console.error('Warning: Registry login failed, tenant creation may not work:', error);
  }

  // Generate shared.env files for all existing tenants
  try {
    const count = await regenerateAllSharedEnvFiles();
    if (count > 0) {
      console.log(`Generated shared.env for ${count} tenant(s)`);
    }
  } catch (error) {
    console.error('Warning: Failed to generate shared.env files:', error);
  }

  app.listen(PORT, () => {
    console.log(`Overwatch running on port ${PORT}`);
    console.log(`Managing project: ${config.project.name}`);
    console.log(`Database: ${config.database.type} @ ${config.database.host}`);
    console.log(`Registry: ${config.registry.type} @ ${config.registry.url}`);
  });
}

start();
