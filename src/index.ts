import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { loadConfig, OverwatchConfig, validateEnvironment, formatValidationErrors, clearConfigCache } from './config';
import { loginToAllRegistries } from './adapters/registry';
import { listApps } from './services/app';
import { authMiddleware } from './middleware/auth';
import { rateLimit } from './middleware/rateLimit';
import { auditLog } from './middleware/audit';
import { validateAppId } from './middleware/validators';
import appsRouter from './routes/apps';
import tenantsRouter from './routes/tenants';
import statusRouter from './routes/status';
import authRouter from './routes/auth';
import adminUsersRouter from './routes/adminUsers';
import backupsRouter from './routes/backups';
import envVarsRouter from './routes/envVars';
import auditLogsRouter from './routes/auditLogs';
import monitoringRouter from './routes/monitoring';
import { regenerateAllSharedEnvFiles } from './services/envVars';
import { startAllBackupSchedulers, stopBackupScheduler } from './services/scheduler';
import { createWebSocketServer, stopWebSocketServer } from './websocket/server';
import { startDockerEventListener, stopDockerEventListener } from './services/dockerEvents';
import { startMetricsCollector, stopMetricsCollector } from './services/metricsCollector';
import { startHealthChecker, stopHealthChecker } from './services/healthChecker';
import { startAlertEngine, stopAlertEngine } from './services/alertEngine';
import { startRetention, stopRetention } from './services/retention';
import { isLegacyFormat, runMigration } from './services/migration';

// Load environment variables
dotenv.config();

// Initialize and start server
async function start() {
  // Run migration if legacy format detected (before loading config)
  if (isLegacyFormat()) {
    console.log('Legacy configuration detected. Running migration...');
    try {
      await runMigration();
      clearConfigCache();
      console.log('Migration completed successfully.');
    } catch (error: any) {
      console.error('Migration failed:', error.message);
      console.error('Continuing with existing config...');
    }
  }

  // Validate configuration
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

  // Trust the first proxy hop (Traefik/nginx) for correct req.ip
  app.set('trust proxy', 1);

  // Middleware
  app.use(express.json({ limit: '1mb' }));

  // CORS — restrict to same origin (SPA served from same host)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self' https://accounts.google.com wss:; frame-src https://accounts.google.com");
    next();
  });

  // Serve React UI from ui/dist/ (falls back to public/ if ui/dist doesn't exist)
  const uiDistPath = path.join(__dirname, '../ui/dist');
  const publicPath = path.join(__dirname, '../public');
  const fs = require('fs');
  const staticPath = fs.existsSync(uiDistPath) ? uiDistPath : publicPath;
  app.use(express.static(staticPath));

  // Rate limiting
  const apiLimiter = rateLimit({ windowMs: 60_000, maxRequests: 100 });
  const authLimiter = rateLimit({ windowMs: 60_000, maxRequests: 10, message: 'Too many login attempts, please try again later' });

  // Health check (no auth)
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      project: config.project.name,
      timestamp: new Date().toISOString(),
      buildTime: process.env.BUILD_TIME || 'dev',
      buildCommit: process.env.BUILD_COMMIT || 'dev',
    });
  });

  // Auth routes — login gets strict rate limit, verify/config get regular limit
  app.post('/api/auth/google', authLimiter);
  app.use('/api/auth', apiLimiter, authRouter);

  // App routes (with auth + appId validation for :appId sub-routes)
  app.use('/api/apps', authMiddleware, apiLimiter, auditLog, appsRouter);

  // App-scoped routes
  app.use('/api/apps/:appId/tenants', authMiddleware, validateAppId, apiLimiter, auditLog, tenantsRouter);
  app.use('/api/apps/:appId/env-vars', authMiddleware, validateAppId, apiLimiter, auditLog, envVarsRouter);
  app.use('/api/apps/:appId/backups', authMiddleware, validateAppId, apiLimiter, auditLog, backupsRouter);

  // Global routes
  app.use('/api/admin-users', authMiddleware, apiLimiter, auditLog, adminUsersRouter);
  app.use('/api/status', authMiddleware, apiLimiter, statusRouter);
  app.use('/api/audit-logs', authMiddleware, apiLimiter, auditLogsRouter);
  app.use('/api/monitoring', authMiddleware, apiLimiter, monitoringRouter);

  // Serve frontend for all other routes (SPA fallback)
  app.get('*', (_req, res) => {
    const indexPath = path.join(staticPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: 'Frontend not found' });
    }
  });

  // Global error handler — log full error server-side, return sanitized message to client
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`Error in ${req.method} ${req.path}:`, err);
    const status = err.status || err.statusCode || 500;
    // Only expose error messages for client errors (4xx); use generic message for server errors (5xx)
    const message = status < 500 ? (err.message || 'Bad request') : 'Internal server error';
    res.status(status).json({ error: message });
  });

  // Login to container registries for all apps
  try {
    const apps = await listApps();
    if (apps.length > 0) {
      await loginToAllRegistries(apps);
    } else {
      console.log('No apps configured yet. Registry login skipped.');
    }
  } catch (error) {
    console.error('Warning: Registry login failed:', error);
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

  // Start per-app backup schedulers
  try {
    await startAllBackupSchedulers();
  } catch (error) {
    console.error('Warning: Failed to start backup schedulers:', error);
  }

  const server = app.listen(PORT, () => {
    console.log(`Overwatch running on port ${PORT}`);
    console.log(`Managing project: ${config.project.name}`);
    console.log(`Database: ${config.database.type} @ ${config.database.host}`);
  });

  // Start WebSocket server
  createWebSocketServer(server);

  // Start monitoring services if enabled
  const monitoringEnabled = config.monitoring?.enabled !== false;
  if (monitoringEnabled) {
    startDockerEventListener();
    const metricsInterval = config.monitoring?.metrics_interval || 15;
    startMetricsCollector(metricsInterval);
    startHealthChecker();
    startAlertEngine();
  }

  // Start log retention pruner
  startRetention();

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received — shutting down gracefully...`);

    stopRetention();
    stopBackupScheduler();
    stopAlertEngine();
    stopHealthChecker();
    stopMetricsCollector();
    stopDockerEventListener();
    stopWebSocketServer();

    server.close(() => {
      console.log('All connections closed. Exiting.');
      process.exit(0);
    });

    setTimeout(() => {
      console.error('Shutdown timed out after 30s — forcing exit.');
      process.exit(1);
    }, 30_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();
