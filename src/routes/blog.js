import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/init.js';
import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';
import { format } from 'date-fns';

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
      `SELECT 
        p.*,
        u.email as author_email,
        COUNT(DISTINCT c.id) as comments_count,
        COUNT(DISTINCT l.id) as likes_count
       FROM blog_posts p
       LEFT JOIN users u ON p.author = u.id
       LEFT JOIN blog_comments c ON p.id = c.post_id
       LEFT JOIN blog_likes l ON p.id = l.post_id
       ${!checkAdminPassphrase(req) ? "WHERE p.status = 'published'" : ''} 
       GROUP BY p.id
       ORDER BY p.created_at DESC`
    );

    // Format posts for response
    const formattedPosts = posts.map(post => ({
      ...post,
      created_at: format(new Date(post.created_at), 'yyyy-MM-dd HH:mm:ss'),
      updated_at: format(new Date(post.updated_at), 'yyyy-MM-dd HH:mm:ss'),
      author: {
        email: post.author_email,
        name: post.author_email?.split('@')[0] || 'Anonymous'
      },
      engagement_metrics: {
        comments_count: post.comments_count,
        likes_count: post.likes_count
      }
    }));

    res.json(formattedPosts);
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
      `SELECT 
        p.*,
        u.email as author_email,
        COUNT(DISTINCT c.id) as comments_count,
        COUNT(DISTINCT l.id) as likes_count
       FROM blog_posts p
       LEFT JOIN users u ON p.author = u.id
       LEFT JOIN blog_comments c ON p.id = c.post_id
       LEFT JOIN blog_likes l ON p.id = l.post_id
       WHERE p.slug = ? ${!checkAdminPassphrase(req) ? "AND p.status = 'published'" : ''}
       GROUP BY p.id`,
      [req.params.slug]
    );

    if (posts.length === 0) {
      return res.status(404).json({ error: 'Blog post not found' });
    }

    // Format post for response
    const post = {
      ...posts[0],
      created_at: format(new Date(posts[0].created_at), 'yyyy-MM-dd HH:mm:ss'),
      updated_at: format(new Date(posts[0].updated_at), 'yyyy-MM-dd HH:mm:ss'),
      author: {
        email: posts[0].author_email,
        name: posts[0].author_email?.split('@')[0] || 'Anonymous'
      },
      engagement_metrics: {
        comments_count: posts[0].comments_count,
        likes_count: posts[0].likes_count
      }
    };

    // Increment view count
    await connection.query(
      'UPDATE blog_posts SET views = views + 1 WHERE id = ?',
      [post.id]
    );

    res.json(post);
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
      `SELECT DISTINCT category, 
        COUNT(*) as post_count 
       FROM blog_posts 
       ${!checkAdminPassphrase(req) ? "WHERE status = 'published'" : ''} 
       GROUP BY category 
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

// Like a blog post
router.post('/posts/:id/like', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const postId = req.params.id;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    // Check if user already liked the post
    const [existingLike] = await connection.query(
      'SELECT id FROM blog_likes WHERE post_id = ? AND user_id = ?',
      [postId, userId]
    );

    if (existingLike.length > 0) {
      // Unlike
      await connection.query(
        'DELETE FROM blog_likes WHERE post_id = ? AND user_id = ?',
        [postId, userId]
      );
      res.json({ message: 'Post unliked successfully' });
    } else {
      // Like
      await connection.query(
        'INSERT INTO blog_likes (post_id, user_id) VALUES (?, ?)',
        [postId, userId]
      );
      res.json({ message: 'Post liked successfully' });
    }
  } catch (error) {
    console.error('Failed to like/unlike post:', error);
    res.status(500).json({ error: 'Failed to like/unlike post' });
  } finally {
    connection.release();
  }
});

// Add a comment
router.post('/posts/:id/comments', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { content } = req.body;
    const postId = req.params.id;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!content) {
      return res.status(400).json({ error: 'Comment content is required' });
    }

    const sanitizedContent = DOMPurify.sanitize(content);

    const id = uuidv4();
    await connection.query(
      'INSERT INTO blog_comments (id, post_id, user_id, content) VALUES (?, ?, ?, ?)',
      [id, postId, userId, sanitizedContent]
    );

    res.json({ message: 'Comment added successfully', id });
  } catch (error) {
    console.error('Failed to add comment:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  } finally {
    connection.release();
  }
});

// Get comments for a post
router.get('/posts/:id/comments', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [comments] = await connection.query(
      `SELECT c.*, u.email as author_email
       FROM blog_comments c
       LEFT JOIN users u ON c.user_id = u.id
       WHERE c.post_id = ?
       ORDER BY c.created_at DESC`,
      [req.params.id]
    );

    const formattedComments = comments.map(comment => ({
      ...comment,
      created_at: format(new Date(comment.created_at), 'yyyy-MM-dd HH:mm:ss'),
      author: {
        email: comment.author_email,
        name: comment.author_email?.split('@')[0] || 'Anonymous'
      }
    }));

    res.json(formattedComments);
  } catch (error) {
    console.error('Failed to fetch comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  } finally {
    connection.release();
  }
});

export default router;
