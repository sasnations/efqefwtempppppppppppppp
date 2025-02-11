import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const router = express.Router();

// Initialize DOMPurify
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

// Helper function to check admin passphrase
const checkAdminPassphrase = (req) => {
  return req.headers['admin-access'] === process.env.ADMIN_PASSPHRASE;
};

// Create a new blog post
router.post('/posts', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

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
      status = 'draft',
      author
    } = req.body;

    if (!title || !content || !category) {
      return res.status(400).json({ error: 'Title, content and category are required' });
    }

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

    const id = uuidv4();
    await connection.query(
      `INSERT INTO blog_posts (
        id, title, slug, content, category, meta_title, 
        meta_description, keywords, featured_image, status, 
        author, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        id, title, slug, sanitizedContent, category, meta_title,
        meta_description, keywords, featured_image, status,
        author
      ]
    );

    res.json({ 
      message: 'Blog post created successfully',
      id,
      slug 
    });
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
       ${!checkAdminPassphrase(req) ? "WHERE status = 'published'" : ''} 
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
       WHERE slug = ? ${!checkAdminPassphrase(req) ? "AND status = 'published'" : ''}`,
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
router.put('/posts/:id', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

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
      status,
      author
    } = req.body;

    if (!title || !content || !category) {
      return res.status(400).json({ error: 'Title, content and category are required' });
    }

    // Check if post exists
    const [existingPost] = await connection.query(
      'SELECT id FROM blog_posts WHERE id = ?',
      [req.params.id]
    );

    if (existingPost.length === 0) {
      return res.status(404).json({ error: 'Blog post not found' });
    }

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
        title = ?, 
        slug = ?, 
        content = ?, 
        category = ?,
        meta_title = ?, 
        meta_description = ?, 
        keywords = ?,
        featured_image = ?, 
        status = ?, 
        author = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        title, slug, sanitizedContent, category,
        meta_title, meta_description, keywords,
        featured_image, status, author, req.params.id
      ]
    );

    res.json({ 
      message: 'Blog post updated successfully',
      slug 
    });
  } catch (error) {
    console.error('Failed to update blog post:', error);
    res.status(500).json({ error: 'Failed to update blog post' });
  } finally {
    connection.release();
  }
});

// Delete a blog post
router.delete('/posts/:id', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const connection = await pool.getConnection();
  try {
    // Check if post exists
    const [posts] = await connection.query(
      'SELECT id FROM blog_posts WHERE id = ?',
      [req.params.id]
    );

    if (posts.length === 0) {
      return res.status(404).json({ error: 'Blog post not found' });
    }

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
       ${!checkAdminPassphrase(req) ? "WHERE status = 'published'" : ''} 
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
