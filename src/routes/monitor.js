import express from 'express';
import { pool } from '../db/init.js';

const router = express.Router();

// Helper function to check admin passphrase
const checkAdminPassphrase = (req) => {
  return req.headers['admin-access'] === process.env.ADMIN_PASSPHRASE;
};

// Get overall statistics
router.get('/stats', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const connection = await pool.getConnection();
  try {
    // Get total users count
    const [usersCount] = await connection.query(
      'SELECT COUNT(*) as total FROM users'
    );

    // Get users registered today
    const [todayUsers] = await connection.query(
      'SELECT COUNT(*) as total FROM users WHERE DATE(created_at) = CURDATE()'
    );

    // Get total temp emails count
    const [emailsCount] = await connection.query(
      'SELECT COUNT(*) as total FROM temp_emails'
    );

    // Get active temp emails count
    const [activeEmailsCount] = await connection.query(
      'SELECT COUNT(*) as total FROM temp_emails WHERE expires_at > NOW()'
    );

    // Get total received emails count
    const [receivedEmailsCount] = await connection.query(
      'SELECT COUNT(*) as total FROM received_emails'
    );

    // Get today's received emails count
    const [todayReceivedCount] = await connection.query(
      'SELECT COUNT(*) as total FROM received_emails WHERE DATE(received_at) = CURDATE()'
    );

    res.json({
      users: {
        total: usersCount[0].total,
        today: todayUsers[0].total
      },
      tempEmails: {
        total: emailsCount[0].total,
        active: activeEmailsCount[0].total
      },
      receivedEmails: {
        total: receivedEmailsCount[0].total,
        today: todayReceivedCount[0].total
      }
    });
  } catch (error) {
    console.error('Failed to fetch stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  } finally {
    connection.release();
  }
});

// Get recent user registrations
router.get('/recent-users', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const [users] = await pool.query(
      `SELECT id, email, created_at, last_login, 
      (SELECT COUNT(*) FROM temp_emails WHERE user_id = users.id) as email_count
      FROM users 
      ORDER BY created_at DESC 
      LIMIT 50`
    );
    res.json(users);
  } catch (error) {
    console.error('Failed to fetch recent users:', error);
    res.status(500).json({ error: 'Failed to fetch recent users' });
  }
});

// Get user activity
router.get('/user-activity', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const [activity] = await pool.query(
      `SELECT 
        DATE(created_at) as date,
        COUNT(*) as registrations,
        COUNT(DISTINCT user_id) as active_users
      FROM users
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
      GROUP BY DATE(created_at)
      ORDER BY date DESC`
    );
    res.json(activity);
  } catch (error) {
    console.error('Failed to fetch user activity:', error);
    res.status(500).json({ error: 'Failed to fetch user activity' });
  }
});

// Get top users by email count
router.get('/top-users', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const [topUsers] = await pool.query(
      `SELECT 
        u.id,
        u.email,
        COUNT(te.id) as email_count,
        COUNT(DISTINCT re.id) as received_count
      FROM users u
      LEFT JOIN temp_emails te ON u.id = te.user_id
      LEFT JOIN received_emails re ON te.id = re.temp_email_id
      GROUP BY u.id, u.email
      ORDER BY email_count DESC
      LIMIT 20`
    );
    res.json(topUsers);
  } catch (error) {
    console.error('Failed to fetch top users:', error);
    res.status(500).json({ error: 'Failed to fetch top users' });
  }
});

// Get system health status
router.get('/health', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // Check database connection
    const connection = await pool.getConnection();
    await connection.query('SELECT 1');
    connection.release();

    // Get system metrics
    const [dbSize] = await pool.query(
      'SELECT table_schema as database_name, ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) as size_mb FROM information_schema.tables GROUP BY table_schema'
    );

    res.json({
      status: 'healthy',
      database: {
        connected: true,
        size: dbSize[0]?.size_mb || 0
      },
      lastChecked: new Date().toISOString()
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message
    });
  }
});

export default router;
