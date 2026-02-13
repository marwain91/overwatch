import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { loadConfig, OverwatchConfig, validateEnvironment, formatValidationErrors } from './config';
import { loginToRegistry } from './adapters/registry';
import { authMiddleware } from './middleware/auth';
import { rateLimit } from './middleware/rateLimit';
import { auditLog } from './middleware/audit';
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

// Validate all required environment variables based on config
const validationErrors = validateEnvironment(config);
if (validationErrors.length > 0) {
  console.error(formatValidationErrors(validationErrors));
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Rate limiting
const apiLimiter = rateLimit({ windowMs: 60_000, maxRequests: 100 });
const authLimiter = rateLimit({ windowMs: 60_000, maxRequests: 10, message: 'Too many login attempts, please try again later' });

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

// Auth routes (no auth required, stricter rate limit)
app.use('/api/auth', authLimiter, authRouter);

// API routes (with auth, rate limiting, and audit logging)
app.use('/api/tenants', authMiddleware, apiLimiter, auditLog, tenantsRouter);
app.use('/api/admin-users', authMiddleware, apiLimiter, auditLog, adminUsersRouter);
app.use('/api/status', authMiddleware, apiLimiter, statusRouter);
app.use('/api/backups', authMiddleware, apiLimiter, auditLog, backupsRouter);
app.use('/api/env-vars', authMiddleware, apiLimiter, auditLog, envVarsRouter);

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
