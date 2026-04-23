import express from 'express';
import path from 'path';
import dotenv from 'dotenv';
import { loadConfig, OverwatchConfig, validateEnvironment, formatValidationErrors, clearConfigCache } from './config';
import { loginToAllRegistries } from './adapters/registry';
import { listApps } from './services/app';
import { authMiddleware } from './middleware/auth';
import { rateLimit, destructiveRateLimit } from './middleware/rateLimit';
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
import databaseRouter from './routes/database';
import { regenerateAllSharedEnvFiles, backfillComposeProjectNames, tightenSecretFilePermissions } from './services/envVars';
import { startAllBackupSchedulers, stopBackupScheduler, reportAbandonedRuns } from './services/scheduler';
import { flushAuditLog } from './middleware/audit';
import { createWebSocketServer, stopWebSocketServer } from './websocket/server';
import { startDockerEventListener, stopDockerEventListener } from './services/dockerEvents';
import { startMetricsCollector, stopMetricsCollector } from './services/metricsCollector';
import { startHealthChecker, stopHealthChecker } from './services/healthChecker';
import { startAlertEngine, stopAlertEngine } from './services/alertEngine';
import { startRetention, stopRetention } from './services/retention';
import { isLegacyFormat, runMigration } from './services/migration';
import { readSchemaVersions, findPendingMigrations, ensureSchemaVersionsInitialised } from './services/schemaVersions';
import { createSnapshot, pruneOldSnapshots } from './services/configSnapshots';
import cron from 'node-cron';

// Load environment variables
dotenv.config();

// Initialize and start server
async function start() {
  // Migration is now explicit: run `overwatch migrate up` out-of-band.
  // Auto-run on boot is opt-in via OVERWATCH_AUTO_MIGRATE=1 for environments
  // (like container images) where a separate step is inconvenient.
  if (isLegacyFormat()) {
    if (process.env.OVERWATCH_AUTO_MIGRATE === '1') {
      console.log('Legacy configuration detected. OVERWATCH_AUTO_MIGRATE=1 — running migration...');
      try {
        await runMigration();
        clearConfigCache();
        console.log('Migration completed successfully.');
      } catch (error: any) {
        console.error('Migration failed:', error.message);
        process.exit(1);
      }
    } else {
      console.error('Legacy configuration detected but OVERWATCH_AUTO_MIGRATE is not set.');
      console.error('Run `overwatch migrate up` to migrate, or set OVERWATCH_AUTO_MIGRATE=1 and restart.');
      process.exit(1);
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
    res.setHeader('Referrer-Policy', 'no-referrer');
    // script-src dropped 'unsafe-inline': a XSS sink in our React bundle or a dep
    // must not be able to execute inline. Style still needs 'unsafe-inline' for
    // Tailwind's runtime style injection; styles cannot exfiltrate tokens.
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://accounts.google.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self' https://accounts.google.com wss:; frame-src https://accounts.google.com; object-src 'none'; base-uri 'self'");
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
  const destructiveLimiter = destructiveRateLimit({ windowMs: 60_000, maxRequests: 5, message: 'Too many destructive requests, slow down.' });

  // Health check (no auth). Returns only liveness; project name and build
  // metadata are gated behind auth via /api/status so unauthenticated probes
  // (and docker HEALTHCHECK) don't leak target fingerprinting info.
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Auth routes — login gets strict rate limit, verify/config get regular limit
  app.post('/api/auth/google', authLimiter);
  app.use('/api/auth', apiLimiter, authRouter);

  // App routes (with auth + appId validation for :appId sub-routes)
  app.use('/api/apps', authMiddleware, apiLimiter, destructiveLimiter, auditLog, appsRouter);

  // App-scoped routes
  app.use('/api/apps/:appId/tenants', authMiddleware, validateAppId, apiLimiter, destructiveLimiter, auditLog, tenantsRouter);
  app.use('/api/apps/:appId/env-vars', authMiddleware, validateAppId, apiLimiter, destructiveLimiter, auditLog, envVarsRouter);
  app.use('/api/apps/:appId/backups', authMiddleware, validateAppId, apiLimiter, destructiveLimiter, auditLog, backupsRouter);

  // Global routes
  app.use('/api/admin-users', authMiddleware, apiLimiter, destructiveLimiter, auditLog, adminUsersRouter);
  app.use('/api/status', authMiddleware, apiLimiter, statusRouter);
  app.use('/api/audit-logs', authMiddleware, apiLimiter, auditLogsRouter);
  app.use('/api/monitoring', authMiddleware, apiLimiter, monitoringRouter);
  app.use('/api/database', authMiddleware, apiLimiter, auditLog, databaseRouter);

  // Serve frontend for all other routes (SPA fallback)
  app.get('*', (_req, res) => {
    const indexPath = path.join(staticPath, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).json({ error: 'Frontend not found' });
    }
  });

  // Global error handler — log full error server-side, return message to client
  app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(`Error in ${req.method} ${req.path}:`, err);
    const status = err.status || err.statusCode || 500;
    const message = err.message || (status < 500 ? 'Bad request' : 'Internal server error');
    res.status(status).json({ error: message });
  });

  // Helper: run a startup step with typed error handling.
  // critical=true aborts boot if the step throws (fail-fast). critical=false logs and continues.
  const runStartupStep = async (
    name: string,
    fn: () => Promise<unknown>,
    opts: { critical: boolean } = { critical: false }
  ): Promise<void> => {
    try {
      await fn();
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (opts.critical) {
        console.error(`[startup] FATAL: ${name} — ${msg}`);
        console.error(err?.stack || '');
        process.exit(1);
      }
      console.error(`[startup] Warning: ${name} — ${msg}`);
    }
  };

  // Critical: if listApps() throws, apps.d/ or apps.runtime.json is corrupt or
  // unreadable — abort boot, don't start schedulers/metrics with a silently empty list.
  let bootApps: Awaited<ReturnType<typeof listApps>> = [];
  await runStartupStep('list apps', async () => {
    bootApps = await listApps();
    console.log(`[startup] Loaded ${bootApps.length} app(s)`);
  }, { critical: true });

  // Critical: refuse to boot if any data store is at a newer version than this
  // binary knows — that would silently downgrade. If pending migrations exist,
  // require explicit opt-in (same gate as legacy migration above).
  await runStartupStep('schema versions', async () => {
    const stored = await readSchemaVersions();
    const pending = findPendingMigrations(stored);
    if (pending.length > 0) {
      if (process.env.OVERWATCH_AUTO_MIGRATE !== '1') {
        const list = pending.map(p => `${p.store} v${p.from}→v${p.to}`).join(', ');
        throw new Error(`Pending data migrations (${list}). Run 'overwatch migrate up' or set OVERWATCH_AUTO_MIGRATE=1.`);
      }
      console.log(`[startup] OVERWATCH_AUTO_MIGRATE=1 — migrations will run as needed`);
    }
    await ensureSchemaVersionsInitialised();
  }, { critical: true });

  await runStartupStep('registry login', async () => {
    if (bootApps.length > 0) {
      await loginToAllRegistries(bootApps);
    } else {
      console.log('No apps configured yet. Registry login skipped.');
    }
  });

  await runStartupStep('tighten secret file permissions', async () => {
    const tightened = await tightenSecretFilePermissions();
    if (tightened > 0) console.log(`Tightened permissions (0600) on ${tightened} secret file(s)`);
  });

  await runStartupStep('backfill COMPOSE_PROJECT_NAME', async () => {
    const backfilled = await backfillComposeProjectNames();
    if (backfilled > 0) console.log(`Backfilled COMPOSE_PROJECT_NAME for ${backfilled} tenant(s)`);
  });

  await runStartupStep('regenerate shared.env', async () => {
    const count = await regenerateAllSharedEnvFiles();
    if (count > 0) console.log(`Generated shared.env for ${count} tenant(s)`);
  });

  await runStartupStep('seed per-tenant app-definition snapshots', async () => {
    const { seedMissingTenantAppDefs } = await import('./services/tenantAppDef');
    const { seeded, skipped } = await seedMissingTenantAppDefs();
    if (seeded > 0) {
      console.log(`[tenant-app-def] Seeded ${seeded} tenant snapshot(s); ${skipped} already present.`);
    }
  });

  await runStartupStep('report abandoned backup runs', () => reportAbandonedRuns());
  await runStartupStep('start backup schedulers', () => startAllBackupSchedulers());

  // Daily config snapshot: protects against apps.d/, apps.runtime.json, env-vars.json loss.
  // 03:17 UTC (off-peak). Also run one immediately on boot so we have a recent snapshot.
  await runStartupStep('initial config snapshot', async () => {
    const info = await createSnapshot('boot');
    console.log(`[snapshot] Created ${info.name} (${info.files.length} file(s))`);
  });
  cron.schedule('17 3 * * *', async () => {
    try {
      const info = await createSnapshot('daily');
      const pruned = await pruneOldSnapshots(30);
      console.log(`[snapshot] Daily ${info.name}; pruned ${pruned}`);
    } catch (err: any) {
      console.error(`[snapshot] Daily snapshot failed: ${err?.message || err}`);
    }
  });

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
      // Drain the audit queue before exit — queued entries would otherwise be
      // lost on SIGTERM (fire-and-forget writes were never awaited).
      flushAuditLog().catch(() => {}).finally(() => {
        console.log('All connections closed. Exiting.');
        process.exit(0);
      });
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
