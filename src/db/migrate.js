import mysql from 'mysql2/promise';
import dotenv from 'dotenv';

dotenv.config();

const migration = `
  ALTER TABLE users 
  ADD COLUMN IF NOT EXISTS reset_token VARCHAR(255) DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMP DEFAULT NULL;
`;

async function runMigration() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME
    });

    console.log('Running migration...');
    await connection.query(migration);
    console.log('Migration completed successfully!');
    
    await connection.end();
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

runMigration();
