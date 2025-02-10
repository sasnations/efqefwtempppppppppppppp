import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

// Create the pool with optimized settings
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 220,
  maxIdle: 50,
  idleTimeout: 60000,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 60000,
  ssl: {
    rejectUnauthorized: false
  }
});

// Add event listeners for better error handling
pool.on('connection', (connection) => {
  console.log('New database connection established');
  
  connection.on('error', (err) => {
    console.error('Database connection error:', err);
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
      console.error('Database connection was closed');
    }
    if (err.code === 'ER_CON_COUNT_ERROR') {
      console.error('Database has too many connections');
    }
    if (err.code === 'ECONNREFUSED') {
      console.error('Database connection was refused');
    }
  });
});

// Check database connection health
export async function checkDatabaseConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.query('SELECT 1');
    connection.release();
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
}

export async function initializeDatabase() {
  try {
    console.log('Attempting to connect to database...');
    console.log('Database host:', process.env.DB_HOST);
    
    const connection = await pool.getConnection();
    console.log('Successfully connected to database');
    
    // Test the connection
    await connection.query('SELECT 1');
    
    // Create tables
    await createTables(connection);
    
    connection.release();
    console.log('Database initialized successfully');
    return pool;
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

async function createTables(connection) {
  // Users table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(36) PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      google_id VARCHAR(255) UNIQUE,
      is_admin BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP,
      INDEX idx_user_email (email),
      INDEX idx_google_id (google_id)
    );
  `);

  // Domains table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS domains (
      id VARCHAR(36) PRIMARY KEY,
      domain VARCHAR(255) UNIQUE NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_domain_name (domain)
    );
  `);

  // Temporary emails table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS temp_emails (
      id VARCHAR(36) PRIMARY KEY,
      user_id VARCHAR(36),
      email VARCHAR(255) UNIQUE NOT NULL,
      domain_id VARCHAR(36) NOT NULL,
      expires_at TIMESTAMP NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE,
      INDEX idx_temp_email (email),
      INDEX idx_user_id (user_id),
      INDEX idx_expiry (expires_at)
    );
  `);

  // Received emails table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS received_emails (
      id VARCHAR(36) PRIMARY KEY,
      temp_email_id VARCHAR(36) NOT NULL,
      from_email VARCHAR(255) NOT NULL,
      from_name VARCHAR(255) NOT NULL,
      subject TEXT,
      body_html LONGTEXT,
      body_text LONGTEXT,
      received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (temp_email_id) REFERENCES temp_emails(id) ON DELETE CASCADE,
      INDEX idx_temp_email_id (temp_email_id),
      INDEX idx_received_at (received_at)
    );
  `);

  // Email attachments table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS email_attachments (
      id VARCHAR(36) PRIMARY KEY,
      email_id VARCHAR(36) NOT NULL,
      filename VARCHAR(255) NOT NULL,
      content_type VARCHAR(100),
      size BIGINT,
      content LONGTEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (email_id) REFERENCES received_emails(id) ON DELETE CASCADE,
      INDEX idx_email_id (email_id),
      INDEX idx_attachment_filename (filename)
    );
  `);

  // Custom messages table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS custom_messages (
      id VARCHAR(36) PRIMARY KEY,
      content TEXT NOT NULL,
      type ENUM('info', 'warning', 'success', 'error') NOT NULL DEFAULT 'info',
      is_active BOOLEAN DEFAULT TRUE,
      created_by VARCHAR(36),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_active_messages (is_active),
      INDEX idx_created_at (created_at)
    );
  `);

  // User dismissed messages table
  await connection.query(`
    CREATE TABLE IF NOT EXISTS user_dismissed_messages (
      user_id VARCHAR(36) NOT NULL,
      message_id VARCHAR(36) NOT NULL,
      dismissed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, message_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES custom_messages(id) ON DELETE CASCADE,
      INDEX idx_user_dismissals (user_id, dismissed_at)
    );
  `);
}

// Cleanup function
async function cleanup() {
  try {
    await pool.end();
    console.log('All database connections closed');
  } catch (err) {
    console.error('Error closing database connections:', err);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);

export { pool };
