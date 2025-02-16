import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

const router = express.Router();

// Initialize DOMPurify with custom config
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window);

// Configure DOMPurify to allow iframes from trusted sources
DOMPurify.setConfig({
  ADD_TAGS: ['iframe'],
  ADD_ATTR: ['allow', 'allowfullscreen', 'frameborder', 'scrolling', 'src', 'title', 'width', 'height'],
  ALLOWED_URI_REGEXP: /^(?:(?:(?:f|ht)tps?|mailto|tel|callto|cid|xmpp|xxx):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  ALLOWED_TAGS: [
    'a', 'b', 'br', 'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'i', 'iframe', 'img', 'li', 'ol', 'p', 'span', 'strong', 'ul'
  ]
});

// Function to validate YouTube URLs
const isValidYouTubeUrl = (url) => {
  return url.match(/^https?:\/\/(www\.)?youtube\.com\/embed\/[a-zA-Z0-9_-]+/);
};

// Modify the sanitization function
const sanitizeContent = (content) => {
  return DOMPurify.sanitize(content, {
    CUSTOM_ELEMENT_HANDLING: {
      tagNameCheck: /^(iframe)$/,
      attributeNameCheck: /^(src|width|height|frameborder|allow|allowfullscreen)$/,
      allowCustomizedBuiltInElements: true
    },
    FORBID_ATTR: [],
    FORBID_TAGS: [],
    ALLOW_UNKNOWN_PROTOCOLS: true,
    transformTags: {
      'iframe': (tagName, attribs) => {
        // Only allow YouTube embeds
        if (!isValidYouTubeUrl(attribs.src)) {
          return {
            tagName: 'p',
            text: '[Invalid video embed]'
          };
        }
        return {
          tagName: 'iframe',
          attribs: {
            ...attribs,
            width: '100%',
            height: '400',
            frameborder: '0',
            allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture',
            allowfullscreen: ''
          }
        };
      }
    }
  });
};

// Helper function to check admin passphrase
const checkAdminPassphrase = (req) => {
  return req.headers['admin-access'] === process.env.ADMIN_PASSPHRASE;
};

// Update the post creation route
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
      author,
      is_featured = false,
      is_trending = false,
      featured_order = null,
      trending_order = null
    } = req.body;

    if (!title || !content || !category) {
      return res.status(400).json({ error: 'Title, content and category are required' });
    }

    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    const [existingSlugs] = await connection.query(
      'SELECT id FROM blog_posts WHERE slug = ?',
      [slug]
    );

    if (existingSlugs.length > 0) {
      return res.status(400).json({ error: 'A post with this title already exists' });
    }

    // Sanitize HTML content with YouTube iframe support
    const sanitizedContent = sanitizeContent(content);

    const id = uuidv4();
    await connection.query(
      `INSERT INTO blog_posts (
        id, title, slug, content, category, meta_title, 
        meta_description, keywords, featured_image, status, 
        author, created_at, updated_at, is_featured, is_trending,
        featured_order, trending_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW(), ?, ?, ?, ?)`,
      [
        id, title, slug, sanitizedContent, category, meta_title,
        meta_description, keywords, featured_image, status,
        author, is_featured, is_trending, featured_order, trending_order
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
    const sanitizedContent = sanitizeContent(content);

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

// Update featured/trending status
router.patch('/posts/:id/status', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const connection = await pool.getConnection();
  try {
    const { is_featured, is_trending, featured_order, trending_order } = req.body;

    await connection.query(
      `UPDATE blog_posts 
       SET is_featured = ?, is_trending = ?, featured_order = ?, trending_order = ?
       WHERE id = ?`,
      [is_featured, is_trending, featured_order, trending_order, req.params.id]
    );

    res.json({ message: 'Post status updated successfully' });
  } catch (error) {
    console.error('Failed to update post status:', error);
    res.status(500).json({ error: 'Failed to update post status' });
  } finally {
    connection.release();
  }
});

// Reorder featured/trending posts
router.post('/posts/reorder', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const connection = await pool.getConnection();
  try {
    const { posts, type } = req.body; // type can be 'featured' or 'trending'
    const orderField = type === 'trending' ? 'trending_order' : 'featured_order';

    for (const post of posts) {
      await connection.query(
        `UPDATE blog_posts SET ${orderField} = ? WHERE id = ?`,
        [post.order, post.id]
      );
    }

    res.json({ message: 'Posts reordered successfully' });
  } catch (error) {
    console.error('Failed to reorder posts:', error);
    res.status(500).json({ error: 'Failed to reorder posts' });
  } finally {
    connection.release();
  }
});

// Get featured posts
router.get('/posts/featured', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [posts] = await connection.query(
      `SELECT * FROM blog_posts 
       WHERE is_featured = true 
       ORDER BY featured_order ASC, created_at DESC`
    );
    res.json(posts);
  } catch (error) {
    console.error('Failed to fetch featured posts:', error);
    res.status(500).json({ error: 'Failed to fetch featured posts' });
  } finally {
    connection.release();
  }
});

// Get trending posts
router.get('/posts/trending', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [posts] = await connection.query(
      `SELECT * FROM blog_posts 
       WHERE is_trending = true 
       ORDER BY trending_order ASC, created_at DESC`
    );
    res.json(posts);
  } catch (error) {
    console.error('Failed to fetch trending posts:', error);
    res.status(500).json({ error: 'Failed to fetch trending posts' });
  } finally {
    connection.release();
  }
});

export default router;
