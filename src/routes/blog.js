import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';
import { authenticateToken } from '../middleware/auth.js';
import DOMPurify from 'dompurify';

const router = express.Router();

// Helper function to check admin passphrase
const checkAdminPassphrase = (req) => {
  return req.headers['admin-access'] === 'esrattormarechudifuck';
};

// Middleware for admin routes
const requireAdminAccess = (req, res, next) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
};

// Create a new blog post
router.post('/posts', requireAdminAccess, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const {
      title,
      content,
      category,
      meta_title,
      meta_description,
      keywords,
      featured_image,
      status = 'draft'
    } = req.body;

    // Generate slug from title
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    // Check for duplicate slug
    const [existingSlugs] = await connection.query(
      'SELECT id FROM blog_posts WHERE slug = ?',
      [slug]
    );

    if (existingSlugs.length > 0) {
      return res.status(400).json({ error: 'A post with this title already exists' });
    }

    // Sanitize HTML content
    const sanitizedContent = DOMPurify.sanitize(content);

    const [result] = await connection.query(
      `INSERT INTO blog_posts (
        id, title, slug, content, category, meta_title, 
        meta_description, keywords, featured_image, status, 
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        uuidv4(), title, slug, sanitizedContent, category, meta_title,
        meta_description, keywords, featured_image, status
      ]
    );

    res.json({ message: 'Blog post created successfully' });
  } catch (error) {
    console.error('Failed to create blog post:', error);
    res.status(500).json({ error: 'Failed to create blog post' });
  } finally {
    connection.release();
  }
});

// Get all blog posts
router.get('/posts', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [posts] = await connection.query(
      `SELECT * FROM blog_posts 
       ${!checkAdminPassphrase(req) ? 'WHERE status = "published"' : ''} 
       ORDER BY created_at DESC`
    );
    res.json(posts);
  } catch (error) {
    console.error('Failed to fetch blog posts:', error);
    res.status(500).json({ error: 'Failed to fetch blog posts' });
  } finally {
    connection.release();
  }
});

// Get a single blog post by slug
router.get('/posts/:slug', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [posts] = await connection.query(
      `SELECT * FROM blog_posts 
       WHERE slug = ? ${!checkAdminPassphrase(req) ? 'AND status = "published"' : ''}`,
      [req.params.slug]
    );

    if (posts.length === 0) {
      return res.status(404).json({ error: 'Blog post not found' });
    }

    res.json(posts[0]);
  } catch (error) {
    console.error('Failed to fetch blog post:', error);
    res.status(500).json({ error: 'Failed to fetch blog post' });
  } finally {
    connection.release();
  }
});

// Update a blog post
router.put('/posts/:id', requireAdminAccess, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const {
      title,
      content,
      category,
      meta_title,
      meta_description,
      keywords,
      featured_image,
      status
    } = req.body;

    // Generate new slug if title changed
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    // Check for duplicate slug
    const [existingSlugs] = await connection.query(
      'SELECT id FROM blog_posts WHERE slug = ? AND id != ?',
      [slug, req.params.id]
    );

    if (existingSlugs.length > 0) {
      return res.status(400).json({ error: 'A post with this title already exists' });
    }

    // Sanitize HTML content
    const sanitizedContent = DOMPurify.sanitize(content);

    await connection.query(
      `UPDATE blog_posts SET 
        title = ?, slug = ?, content = ?, category = ?,
        meta_title = ?, meta_description = ?, keywords = ?,
        featured_image = ?, status = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        title, slug, sanitizedContent, category,
        meta_title, meta_description, keywords,
        featured_image, status, req.params.id
      ]
    );

    res.json({ message: 'Blog post updated successfully' });
  } catch (error) {
    console.error('Failed to update blog post:', error);
    res.status(500).json({ error: 'Failed to update blog post' });
  } finally {
    connection.release();
  }
});

// Delete a blog post
router.delete('/posts/:id', requireAdminAccess, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      'DELETE FROM blog_posts WHERE id = ?',
      [req.params.id]
    );
    res.json({ message: 'Blog post deleted successfully' });
  } catch (error) {
    console.error('Failed to delete blog post:', error);
    res.status(500).json({ error: 'Failed to delete blog post' });
  } finally {
    connection.release();
  }
});

// Get blog categories
router.get('/categories', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [categories] = await connection.query(
      `SELECT DISTINCT category FROM blog_posts 
       ${!checkAdminPassphrase(req) ? 'WHERE status = "published"' : ''} 
       ORDER BY category`
    );
    res.json(categories.map(c => c.category));
  } catch (error) {
    console.error('Failed to fetch categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  } finally {
    connection.release();
  }
});

export default router;
