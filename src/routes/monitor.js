import express from 'express';
import { pool } from '../db/init.js';
import { authenticateToken, requireAdmin } from '../middleware/auth.js';
import { v4 as uuidv4 } from 'uuid';
import {
  lookupRequestById,
  lookupRequestsByIp,
  getIpStats,
  getRecentIps
} from '../middleware/requestTracker.js';

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

    // Get request logs stats
    const [requestsCount] = await connection.query(
      'SELECT COUNT(*) as total FROM request_logs'
    );

    const [todayRequestsCount] = await connection.query(
      'SELECT COUNT(*) as total FROM request_logs WHERE DATE(created_at) = CURDATE()'
    );

    const [uniqueIpsCount] = await connection.query(
      'SELECT COUNT(DISTINCT client_ip) as total FROM request_logs'
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
      },
      requests: {
        total: requestsCount[0].total,
        today: todayRequestsCount[0].total,
        uniqueIps: uniqueIpsCount[0].total
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

// Lookup temporary email to find owner
router.get('/lookup-temp-email', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { email } = req.query;
  
  if (!email) {
    return res.status(400).json({ error: 'Email parameter is required' });
  }

  const connection = await pool.getConnection();
  try {
    // Find the temporary email and join with the users table to get the owner
    const [result] = await connection.query(`
      SELECT 
        te.email as tempEmail,
        u.email as ownerEmail,
        te.created_at,
        te.expires_at,
        (te.expires_at > NOW()) as isActive
      FROM temp_emails te
      LEFT JOIN users u ON te.user_id = u.id
      WHERE te.email = ?
    `, [email]);

    if (result.length === 0) {
      return res.status(404).json({ error: 'Temporary email not found' });
    }

    // For anonymous/public emails (no user_id), indicate it's a public email
    if (!result[0].ownerEmail) {
      result[0].ownerEmail = 'Public/Anonymous Email (No registered user)';
    }

    res.json(result[0]);
  } catch (error) {
    console.error('Failed to lookup temporary email:', error);
    res.status(500).json({ error: 'Failed to lookup temporary email owner' });
  } finally {
    connection.release();
  }
});

// Get recent IPs
router.get('/recent-ips', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    const limit = parseInt(req.query.limit) || 50;
    const recentIps = await getRecentIps(limit);
    res.json(recentIps);
  } catch (error) {
    console.error('Failed to fetch recent IPs:', error);
    res.status(500).json({ error: 'Failed to fetch recent IPs' });
  }
});

// Lookup IP and get detailed statistics
router.get('/lookup-ip', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { ip } = req.query;
  
  if (!ip) {
    return res.status(400).json({ error: 'IP parameter is required' });
  }

  try {
    // Get IP statistics
    const ipStats = await getIpStats(ip);
    
    // Get recent requests from this IP
    const limit = parseInt(req.query.limit) || 50;
    const recentRequests = await lookupRequestsByIp(ip, limit);
    
    // Get associated user information
    const userDetails = [];
    if (ipStats.associatedUsers && ipStats.associatedUsers.length > 0) {
      const placeholders = ipStats.associatedUsers.map(() => '?').join(',');
      const [users] = await pool.query(
        `SELECT id, email, created_at, last_login 
         FROM users
         WHERE id IN (${placeholders})`,
        ipStats.associatedUsers
      );
      
      for (const user of users) {
        const [emailCount] = await pool.query(
          'SELECT COUNT(*) as total FROM temp_emails WHERE user_id = ?',
          [user.id]
        );
        
        userDetails.push({
          ...user,
          emailCount: emailCount[0].total
        });
      }
    }
    
    res.json({
      ip,
      stats: ipStats,
      recentRequests,
      associatedUsers: userDetails
    });
  } catch (error) {
    console.error('Failed to lookup IP:', error);
    res.status(500).json({ error: 'Failed to lookup IP information' });
  }
});

// Lookup request by ID
router.get('/lookup-request', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const { requestId } = req.query;
  
  if (!requestId) {
    return res.status(400).json({ error: 'Request ID parameter is required' });
  }

  try {
    const request = await lookupRequestById(requestId);
    
    if (!request) {
      return res.status(404).json({ error: 'Request not found' });
    }
    
    // If the request has a user ID, get user information
    let userInfo = null;
    if (request.user_id) {
      const [users] = await pool.query(
        'SELECT id, email, created_at, last_login FROM users WHERE id = ?',
        [request.user_id]
      );
      
      if (users.length > 0) {
        const [emailCount] = await pool.query(
          'SELECT COUNT(*) as total FROM temp_emails WHERE user_id = ?',
          [request.user_id]
        );
        
        userInfo = {
          ...users[0],
          emailCount: emailCount[0].total
        };
      }
    }
    
    res.json({
      request,
      userInfo
    });
  } catch (error) {
    console.error('Failed to lookup request:', error);
    res.status(500).json({ error: 'Failed to lookup request information' });
  }
});

// Get IP behavior stats
router.get('/ip-behavior/:ip', async (req, res) => {
  try {
    const { ip } = req.params;
    
    // Get behavior stats
    const [behaviors] = await pool.query(
      `SELECT * FROM ip_behaviors 
       WHERE ip_address = ? 
       ORDER BY detected_at DESC`,
      [ip]
    );

    // Get request patterns
    const [patterns] = await pool.query(
      `SELECT 
         DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') as hour,
         COUNT(*) as request_count,
         AVG(response_time) as avg_response_time,
         COUNT(DISTINCT user_id) as unique_users,
         SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count
       FROM request_logs
       WHERE client_ip = ?
       GROUP BY hour
       ORDER BY hour DESC
       LIMIT 24`,
      [ip]
    );

    // Get blocked status
    const [blockStatus] = await pool.query(
      `SELECT * FROM blocked_ips 
       WHERE ip_address = ? 
       AND (expires_at IS NULL OR expires_at > NOW())`,
      [ip]
    );

    res.json({
      behaviors,
      patterns,
      isBlocked: blockStatus.length > 0,
      blockInfo: blockStatus[0] || null
    });
  } catch (error) {
    console.error('Failed to get IP behavior:', error);
    res.status(500).json({ error: 'Failed to get IP behavior' });
  }
});

// Block IP
router.post('/block-ip', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { ip, reason, duration } = req.body;
    
    const expiresAt = duration ? new Date(Date.now() + duration * 1000) : null;
    
    await pool.query(
      `INSERT INTO blocked_ips (ip_address, reason, blocked_by, expires_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE 
         reason = VALUES(reason),
         blocked_by = VALUES(blocked_by),
         expires_at = VALUES(expires_at),
         updated_at = CURRENT_TIMESTAMP`,
      [ip, reason, req.user.id, expiresAt]
    );

    res.json({ message: 'IP blocked successfully' });
  } catch (error) {
    console.error('Failed to block IP:', error);
    res.status(500).json({ error: 'Failed to block IP' });
  }
});

// Unblock IP
router.post('/unblock-ip', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { ip } = req.body;
    
    await pool.query(
      'DELETE FROM blocked_ips WHERE ip_address = ?',
      [ip]
    );

    res.json({ message: 'IP unblocked successfully' });
  } catch (error) {
    console.error('Failed to unblock IP:', error);
    res.status(500).json({ error: 'Failed to unblock IP' });
  }
});

export default router;
