import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import compression from 'compression';
import cluster from 'cluster';
import os from 'os';
import Memcached from 'memcached-js';
import { initializeDatabase, checkDatabaseConnection, pool } from './db/init.js';
import { cleanupOldEmails } from './utils/cleanup.js';
import { requestTrackerMiddleware } from './middleware/requestTracker.js';
import { checkBlockedIp } from './middleware/ipBlocker.js';
import authRoutes from './routes/auth.js';
import emailRoutes from './routes/emails.js';
import domainRoutes from './routes/domains.js';
import webhookRoutes from './routes/webhook.js';
import messageRoutes from './routes/messages.js';
import blogRoutes from './routes/blog.js';
import monitorRoutes from './routes/monitor.js';
import nodemailer from 'nodemailer';

dotenv.config();

// Number of CPU cores
const numCPUs = os.cpus().length;

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} is running`);

  // Fork workers
  for (let i = 0; i < numCPUs; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died`);
    // Replace the dead worker
    cluster.fork();
  });
} else {
  const app = express();
  const port = process.env.PORT || 3000;

  // Initialize in-memory Memcached
  const memcached = new Memcached({
    maxMemoryMB: 512, // Use up to 512MB RAM
    maxKeySize: 250,
    maxValueSize: 1048576, // 1MB
    maxKeys: 100000,
    cleanupInterval: 60000 // Cleanup every minute
  });

  // Create mail transporter
  export const mailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    },
    tls: {
      rejectUnauthorized: false
    },
    pool: true,
    maxConnections: 20,
    maxMessages: 100
  });

  // Security middleware
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "https://www.google.com/recaptcha/", "https://www.gstatic.com/recaptcha/"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://boomlify.com", "https://www.google.com/recaptcha/"],
        frameSrc: ["https://www.google.com/recaptcha/"]
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" }
  }));

  // Add compression middleware
  app.use(compression());

  // Add request tracking middleware
  app.use(requestTrackerMiddleware);

  // Apply IP blocker to all routes except monitor routes
  app.use(/^(?!\/monitor).*$/, checkBlockedIp);

  // Security headers
  app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    next();
  });

  // Update CORS configuration
  app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Admin-Access'],
    credentials: true,
    exposedHeaders: ['Content-Length', 'X-Requested-With', 'X-Request-ID']
  }));

  app.use(express.json());

  // Health check endpoint
  app.get('/health', async (req, res) => {
    const dbHealthy = await checkDatabaseConnection();
    if (dbHealthy) {
      res.status(200).json({ 
        status: 'healthy',
        database: 'connected',
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(503).json({ 
        status: 'unhealthy',
        database: 'disconnected',
        timestamp: new Date().toISOString()
      });
    }
  });

  // Routes with Memcached integration
  app.use('/auth', (req, res, next) => {
    req.memcached = memcached;
    next();
  }, authRoutes);

  app.use('/emails', (req, res, next) => {
    req.memcached = memcached;
    next();
  }, emailRoutes);

  app.use('/domains', (req, res, next) => {
    req.memcached = memcached;
    next();
  }, domainRoutes);

  app.use('/webhook', (req, res, next) => {
    req.memcached = memcached;
    next();
  }, webhookRoutes);

  app.use('/messages', (req, res, next) => {
    req.memcached = memcached;
    next();
  }, messageRoutes);

  app.use('/blog', (req, res, next) => {
    req.memcached = memcached;
    next();
  }, blogRoutes);

  app.use('/monitor', (req, res, next) => {
    req.memcached = memcached;
    next();
  }, monitorRoutes);

  // Schedule cleanup
  const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  function scheduleCleanup() {
    setInterval(async () => {
      try {
        const deletedCount = await cleanupOldEmails();
        console.log(`Scheduled cleanup completed. Deleted ${deletedCount} old emails.`);
      } catch (error) {
        console.error('Scheduled cleanup failed:', error);
      }
    }, CLEANUP_INTERVAL);
  }

  // Initialize database and start server
  initializeDatabase().then(() => {
    app.listen(port, '0.0.0.0', () => {
      console.log(`Worker ${process.pid} running on port ${port}`);
      scheduleCleanup();
      console.log('Email cleanup scheduler started');
    });
  }).catch(error => {
    console.error('Failed to initialize database:', error);
    process.exit(1);
  });

  // Error handling
  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    console.log('SIGTERM received. Closing Memcached connection...');
    memcached.end();
    process.exit(0);
  });
}

export default app;
