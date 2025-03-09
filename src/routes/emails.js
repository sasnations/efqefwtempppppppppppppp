import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { authenticateToken } from '../middleware/auth.js';
import { pool } from '../db/init.js';
import compression from 'compression';
import { rateLimitMiddleware, verifyCaptcha, checkCaptchaRequired, rateLimitStore } from '../middleware/rateLimit.js';
import { ErrorTypes, AppError } from '../types/errors.js';
import { validateRequest } from '../middleware/errorHandler.js';
import DOMPurify from 'dompurify';
import { JSDOM } from 'jsdom';

const router = express.Router();

// Initialize DOMPurify
const window = new JSDOM('').window;
const purify = DOMPurify(window);

// Configure DOMPurify
purify.setConfig({
  ALLOWED_TAGS: ['p', 'br', 'b', 'i', 'em', 'strong', 'a', 'ul', 'ol', 'li', 'img'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'], // Add target="_blank" to links
  FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'button'],
  FORBID_ATTR: ['onerror', 'onload', 'onclick'],
  SANITIZE_DOM: true
});

// Custom link transformer
purify.addHook('afterSanitizeAttributes', function(node) {
  // Only process anchor tags
  if (node.tagName === 'A') {
    // Force target="_blank" and add security attributes
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
    
    // Validate href
    const href = node.getAttribute('href');
    if (href) {
      // Check if it's an internal link
      const isInternal = href.startsWith(process.env.FRONTEND_URL) || href.startsWith('/');
      
      if (!isInternal) {
        // For external links, add warning class and modify href
        node.setAttribute('class', 'external-link warning');
        node.setAttribute('data-original-url', href);
        node.setAttribute('href', `/redirect?url=${encodeURIComponent(href)}`);
      }
    }
  }
});

// Function to sanitize email content
function sanitizeEmailContent(content) {
  if (!content) return '';
  
  // Sanitize HTML content
  const cleanHtml = purify.sanitize(content, {
    RETURN_DOM_FRAGMENT: false,
    RETURN_DOM: false,
    WHOLE_DOCUMENT: false
  });

  return cleanHtml;
}

// Get a specific temporary email
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const [emails] = await pool.query(
      'SELECT * FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (emails.length === 0) {
      throw new AppError(ErrorTypes.EMAIL.NOT_FOUND);
    }

    res.json(emails[0]);
  } catch (error) {
    next(error);
  }
});

// Get received emails for a specific temporary email with pagination
router.get('/:id/received', authenticateToken, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;

    // First verify ownership
    const [tempEmails] = await pool.query(
      'SELECT id FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (tempEmails.length === 0) {
      throw new AppError(ErrorTypes.EMAIL.NOT_FOUND);
    }

    // Get total count
    const [countResult] = await pool.query(`
      SELECT COUNT(*) as total
      FROM received_emails re
      JOIN temp_emails te ON re.temp_email_id = te.id
      WHERE te.id = ? AND te.user_id = ?
    `, [req.params.id, req.user.id]);

    const totalCount = countResult[0].total;

    // Get paginated data
    const [emails] = await pool.query(`
      SELECT re.*, te.email as temp_email
      FROM received_emails re
      JOIN temp_emails te ON re.temp_email_id = te.id
      WHERE te.id = ? AND te.user_id = ?
      ORDER BY re.received_at DESC
      LIMIT ? OFFSET ?
    `, [req.params.id, req.user.id, limit, offset]);

    // Sanitize content of each email
    const sanitizedEmails = emails.map(email => ({
      ...email,
      body_html: sanitizeEmailContent(email.body_html),
      body_text: email.body_text
    }));

    res.json({
      data: sanitizedEmails,
      metadata: {
        total: totalCount,
        page: page,
        limit: limit,
        pages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

// Create email with rate limit and optional CAPTCHA verification
router.post('/create', authenticateToken, rateLimitMiddleware, checkCaptchaRequired, verifyCaptcha, async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { email, domainId } = req.body;
    
    // Validate input
    if (!email || !domainId) {
      throw new AppError(ErrorTypes.VALIDATION.MISSING_FIELDS, {
        required: ['email', 'domainId']
      });
    }

    // Check if email already exists
    const [existingEmails] = await connection.query(
      'SELECT id FROM temp_emails WHERE email = ?',
      [email]
    );

    if (existingEmails.length > 0) {
      throw new AppError(ErrorTypes.EMAIL.EXISTS);
    }

    // Verify domain exists and is active
    const [domains] = await connection.query(
      'SELECT id FROM domains WHERE id = ? AND is_active = true',
      [domainId]
    );

    if (domains.length === 0) {
      throw new AppError(ErrorTypes.DOMAIN.INVALID);
    }

    const id = uuidv4();
    
    // Set expiry date to 2 months from now
    const expiresAt = new Date();
    expiresAt.setMonth(expiresAt.getMonth() + 2);
    
    await connection.beginTransaction();

    try {
      await connection.query(
        'INSERT INTO temp_emails (id, user_id, email, domain_id, expires_at) VALUES (?, ?, ?, ?, ?)',
        [id, req.user.id, email, domainId, expiresAt]
      );

      // Reset rate limit counter if CAPTCHA was provided
      if (req.body.captchaResponse) {
        if (req.user) {
          if (rateLimitStore.userLimits[req.user.id]) {
            rateLimitStore.userLimits[req.user.id].count = 0;
            rateLimitStore.userLimits[req.user.id].captchaRequired = false;
          }
        } else {
          const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
          if (rateLimitStore.limits[clientIp]) {
            rateLimitStore.limits[clientIp].count = 0;
            rateLimitStore.limits[clientIp].captchaRequired = false;
          }
        }
      }

      await connection.commit();

      const [createdEmail] = await connection.query(
        'SELECT * FROM temp_emails WHERE id = ?',
        [id]
      );

      res.json(createdEmail[0]);
    } catch (error) {
      await connection.rollback();
      throw new AppError(ErrorTypes.EMAIL.CREATION_FAILED, {
        originalError: error.message
      });
    }
  } catch (error) {
    next(error);
  } finally {
    connection.release();
  }
});

// Delete email
router.delete('/delete/:id', authenticateToken, async (req, res, next) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();

    // First verify ownership
    const [emails] = await connection.query(
      'SELECT id FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    if (emails.length === 0) {
      throw new AppError(ErrorTypes.EMAIL.NOT_FOUND);
    }

    // Delete received emails first
    await connection.query(
      'DELETE FROM received_emails WHERE temp_email_id = ?',
      [req.params.id]
    );

    // Then delete the temporary email
    await connection.query(
      'DELETE FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.id, req.user.id]
    );

    await connection.commit();
    res.json({ message: 'Email deleted successfully' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// Get user emails with pagination and search
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const search = req.query.search || '';

    // Build search condition
    let searchCondition = '';
    let searchParams = [req.user.id];
    
    if (search) {
      searchCondition = 'AND email LIKE ?';
      searchParams.push(`%${search}%`);
    }

    // Get total count with search
    const [countResult] = await pool.query(
      `SELECT COUNT(*) as total 
       FROM temp_emails 
       WHERE user_id = ? ${searchCondition}`,
      searchParams
    );
    
    const totalCount = countResult[0].total;

    // Get paginated data with search
    const [emails] = await pool.query(
      `SELECT * FROM temp_emails 
       WHERE user_id = ? ${searchCondition}
       ORDER BY created_at DESC 
       LIMIT ? OFFSET ?`,
      [...searchParams, limit, offset]
    );

    res.json({
      data: emails,
      metadata: {
        total: totalCount,
        page: page,
        limit: limit,
        pages: Math.ceil(totalCount / limit)
      }
    });
  } catch (error) {
    next(error);
  }
});

// Delete a received email
router.delete('/:tempEmailId/received/:emailId', authenticateToken, async (req, res, next) => {
  try {
    // First check if the temp email belongs to the user
    const [tempEmails] = await pool.query(
      'SELECT id FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.tempEmailId, req.user.id]
    );

    if (tempEmails.length === 0) {
      throw new AppError(ErrorTypes.EMAIL.NOT_FOUND);
    }

    // Delete the received email
    const [result] = await pool.query(
      'DELETE FROM received_emails WHERE id = ? AND temp_email_id = ?',
      [req.params.emailId, req.params.tempEmailId]
    );

    if (result.affectedRows === 0) {
      throw new AppError(ErrorTypes.EMAIL.NOT_FOUND);
    }

    res.json({ message: 'Email deleted successfully' });
  } catch (error) {
    next(error);
  }
});

// Bulk delete received emails
router.post('/:tempEmailId/received/bulk/delete', authenticateToken, async (req, res, next) => {
  const { emailIds } = req.body;
  
  if (!emailIds || !Array.isArray(emailIds) || emailIds.length === 0) {
    throw new AppError(ErrorTypes.VALIDATION.FAILED, {
      message: 'Invalid email IDs provided'
    });
  }

  try {
    // First check if the temp email belongs to the user
    const [tempEmails] = await pool.query(
      'SELECT id FROM temp_emails WHERE id = ? AND user_id = ?',
      [req.params.tempEmailId, req.user.id]
    );

    if (tempEmails.length === 0) {
      throw new AppError(ErrorTypes.EMAIL.NOT_FOUND);
    }

    // Delete the received emails
    const [result] = await pool.query(
      'DELETE FROM received_emails WHERE id IN (?) AND temp_email_id = ?',
      [emailIds, req.params.tempEmailId]
    );

    res.json({ 
      message: 'Emails deleted successfully',
      count: result.affectedRows
    });
  } catch (error) {
    next(error);
  }
});

// Get public emails (no auth required)
router.get('/public/:email', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'public, max-age=5'); // Cache for 5 seconds
    const [emails] = await pool.query(`
      SELECT re.*, te.email as temp_email
      FROM received_emails re
      JOIN temp_emails te ON re.temp_email_id = te.id
      WHERE te.email = ?
      ORDER BY re.received_at DESC
    `, [req.params.email]);

    // Sanitize content of each email
    const sanitizedEmails = emails.map(email => ({
      ...email,
      body_html: sanitizeEmailContent(email.body_html),
      body_text: email.body_text
    }));

    res.json(sanitizedEmails);
  } catch (error) {
    next(error);
  }
});

// Create public temporary email (no auth required) with rate limiting and CAPTCHA
router.post('/public/create', rateLimitMiddleware, checkCaptchaRequired, verifyCaptcha, async (req, res, next) => {
  try {
    const { email, domainId } = req.body;
    
    if (!email || !domainId) {
      throw new AppError(ErrorTypes.VALIDATION.MISSING_FIELDS, {
        required: ['email', 'domainId']
      });
    }

    // Verify domain exists and is active
    const [domains] = await pool.query(
      'SELECT id FROM domains WHERE id = ? AND is_active = true',
      [domainId]
    );

    if (domains.length === 0) {
      throw new AppError(ErrorTypes.DOMAIN.INVALID);
    }

    const id = uuidv4();
    
    // Set expiry date to 48 hours from now
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 48);
    
    // If CAPTCHA was provided and successfully verified, reset rate limit counter
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    if (req.body.captchaResponse && rateLimitStore.limits[clientIp]) {
      rateLimitStore.limits[clientIp].count = 0;
      rateLimitStore.limits[clientIp].captchaRequired = false;
    }

    const [result] = await pool.query(
      'INSERT INTO temp_emails (id, email, domain_id, expires_at) VALUES (?, ?, ?, ?)',
      [id, email, domainId, expiresAt]
    );

    const [createdEmail] = await pool.query(
      'SELECT * FROM temp_emails WHERE id = ?',
      [id]
    );

    res.json(createdEmail[0]);
  } catch (error) {
    next(error);
  }
});

// Compress responses
router.use(compression());

export default router;
