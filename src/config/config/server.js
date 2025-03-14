import dotenv from 'dotenv';

dotenv.config();

export const serverConfig = {
  // Server settings
  port: process.env.PORT || 3000,
  env: process.env.NODE_ENV || 'production',
  
  // Memory settings for Render
  memcached: {
    maxMemoryMB: 512, // 512MB memory limit
    maxKeys: 100000,  // 100k max keys
    maxValueSize: 1048576, // 1MB max value size
    cleanupInterval: 60000 // Cleanup every minute
  },

  // Database pool settings optimized for Render
  dbPool: {
    max: 150,       // Render's free tier limit
    min: 50,        // Minimum connections
    idle: 10000,   // 10s idle timeout
    acquire: 30000, // 30s acquire timeout
    queueLimit: 0  // No queue limit
  },

  // Rate limiting
  rateLimit: {
    windowMs: 900000, // 15 minutes
    max: 1000        // 1000 requests per window
  },

  // Server timeouts
  timeouts: {
    server: 120000,    // 120s server timeout
    keepAlive: 65000,  // 65s keepalive
    headers: 60000     // 60s headers timeout
  }
};
