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

// Get all blog posts
router.get('/posts', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [posts] = await connection.query(
      `SELECT 
        p.*,
        u.email as author_email,
        COUNT(DISTINCT c.id) as comments_count,
        COUNT(DISTINCT l.id) as likes_count,
        GROUP_CONCAT(DISTINCT t.name) as tags
       FROM blog_posts p
       LEFT JOIN users u ON p.author = u.id
       LEFT JOIN blog_comments c ON p.id = c.post_id
       LEFT JOIN blog_likes l ON p.id = l.post_id
       LEFT JOIN blog_post_tags pt ON p.id = pt.post_id
       LEFT JOIN blog_tags t ON pt.tag_id = t.id
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
      tags: post.tags ? post.tags.split(',') : [],
      engagement_metrics: {
        comments_count: post.comments_count,
        likes_count: post.likes_count,
        views: post.views || 0,
        shares: post.shares || 0
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
    // First check if post exists
    const [posts] = await connection.query(
      `SELECT 
        p.*,
        u.email as author_email,
        COUNT(DISTINCT c.id) as comments_count,
        COUNT(DISTINCT l.id) as likes_count,
        GROUP_CONCAT(DISTINCT t.name) as tags
       FROM blog_posts p
       LEFT JOIN users u ON p.author = u.id
       LEFT JOIN blog_comments c ON p.id = c.post_id
       LEFT JOIN blog_likes l ON p.id = l.post_id
       LEFT JOIN blog_post_tags pt ON p.id = pt.post_id
       LEFT JOIN blog_tags t ON pt.tag_id = t.id
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
      tags: posts[0].tags ? posts[0].tags.split(',') : [],
      engagement_metrics: {
        comments_count: posts[0].comments_count,
        likes_count: posts[0].likes_count,
        views: posts[0].views || 0,
        shares: posts[0].shares || 0
      }
    };

    // Increment view count safely
    await connection.query(
      'UPDATE blog_posts SET views = COALESCE(views, 0) + 1 WHERE id = ?',
      [post.id]
    );

    // Get related posts
    const [relatedPosts] = await connection.query(
      `SELECT id, title, slug, featured_image, category
       FROM blog_posts
       WHERE category = ? 
       AND id != ?
       AND status = 'published'
       LIMIT 3`,
      [post.category, post.id]
    );

    post.related_posts = relatedPosts;

    res.json(post);
  } catch (error) {
    console.error('Failed to fetch blog post:', error);
    res.status(500).json({ error: 'Failed to fetch blog post' });
  } finally {
    connection.release();
  }
});

// Create a new blog post
router.post('/posts', async (req, res) => {
  if (!checkAdminPassphrase(req)) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const {
      title,
      content,
      excerpt,
      category,
      meta_title,
      meta_description,
      keywords,
      featured_image,
      status = 'draft',
      author,
      tags = []
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

    // Calculate reading time (rough estimate)
    const wordCount = content.split(/\s+/).length;
    const readingTime = Math.ceil(wordCount / 200); // Assuming 200 words per minute

    const id = uuidv4();
    await connection.query(
      `INSERT INTO blog_posts (
        id, title, slug, content, excerpt, category, meta_title, 
        meta_description, keywords, featured_image, status, 
        author, reading_time, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        id, title, slug, sanitizedContent, excerpt, category, meta_title,
        meta_description, keywords, featured_image, status,
        author, readingTime
      ]
    );

    // Handle tags
    if (tags.length > 0) {
      for (const tagName of tags) {
        // Create or get tag
        const [existingTags] = await connection.query(
          'SELECT id FROM blog_tags WHERE name = ?',
          [tagName]
        );

        let tagId;
        if (existingTags.length > 0) {
          tagId = existingTags[0].id;
        } else {
          const tagSlug = tagName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          tagId = uuidv4();
          await connection.query(
            'INSERT INTO blog_tags (id, name, slug) VALUES (?, ?, ?)',
            [tagId, tagName, tagSlug]
          );
        }

        // Link tag to post
        await connection.query(
          'INSERT INTO blog_post_tags (post_id, tag_id) VALUES (?, ?)',
          [id, tagId]
        );
      }
    }

    await connection.commit();

    res.json({ 
      message: 'Blog post created successfully',
      id,
      slug 
    });
  } catch (error) {
    await connection.rollback();
    console.error('Failed to create blog post:', error);
    res.status(500).json({ error: 'Failed to create blog post' });
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
    await connection.beginTransaction();

    const {
      title,
      content,
      excerpt,
      category,
      meta_title,
      meta_description,
      keywords,
      featured_image,
      status,
      tags = []
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

    // Calculate reading time
    const wordCount = content.split(/\s+/).length;
    const readingTime = Math.ceil(wordCount / 200);

    await connection.query(
      `UPDATE blog_posts SET 
        title = ?, 
        slug = ?, 
        content = ?, 
        excerpt = ?,
        category = ?,
        meta_title = ?, 
        meta_description = ?, 
        keywords = ?,
        featured_image = ?, 
        status = ?,
        reading_time = ?,
        updated_at = NOW()
       WHERE id = ?`,
      [
        title, slug, sanitizedContent, excerpt, category,
        meta_title, meta_description, keywords,
        featured_image, status, readingTime, req.params.id
      ]
    );

    // Update tags
    await connection.query(
      'DELETE FROM blog_post_tags WHERE post_id = ?',
      [req.params.id]
    );

    if (tags.length > 0) {
      for (const tagName of tags) {
        const [existingTags] = await connection.query(
          'SELECT id FROM blog_tags WHERE name = ?',
          [tagName]
        );

        let tagId;
        if (existingTags.length > 0) {
          tagId = existingTags[0].id;
        } else {
          const tagSlug = tagName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          tagId = uuidv4();
          await connection.query(
            'INSERT INTO blog_tags (id, name, slug) VALUES (?, ?, ?)',
            [tagId, tagName, tagSlug]
          );
        }

        await connection.query(
          'INSERT INTO blog_post_tags (post_id, tag_id) VALUES (?, ?)',
          [req.params.id, tagId]
        );
      }
    }

    await connection.commit();

    res.json({ 
      message: 'Blog post updated successfully',
      slug 
    });
  } catch (error) {
    await connection.rollback();
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
    await connection.beginTransaction();

    // Check if post exists
    const [posts] = await connection.query(
      'SELECT id FROM blog_posts WHERE id = ?',
      [req.params.id]
    );

    if (posts.length === 0) {
      return res.status(404).json({ error: 'Blog post not found' });
    }

    // Delete related records first
    await connection.query('DELETE FROM blog_post_tags WHERE post_id = ?', [req.params.id]);
    await connection.query('DELETE FROM blog_comments WHERE post_id = ?', [req.params.id]);
    await connection.query('DELETE FROM blog_likes WHERE post_id = ?', [req.params.id]);
    await connection.query('DELETE FROM blog_views WHERE post_id = ?', [req.params.id]);

    // Delete the post
    await connection.query('DELETE FROM blog_posts WHERE id = ?', [req.params.id]);

    await connection.commit();
    res.json({ message: 'Blog post deleted successfully' });
  } catch (error) {
    await connection.rollback();
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
      `SELECT DISTINCT category as name, COUNT(*) as post_count 
       FROM blog_posts 
       ${!checkAdminPassphrase(req) ? "WHERE status = 'published'" : ''} 
       GROUP BY category
       ORDER BY category`
    );
    res.json(categories);
  } catch (error) {
    console.error('Failed to fetch categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  } finally {
    connection.release();
  }
});


// Get blog tags
router.get('/tags', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const [tags] = await connection.query(
      `SELECT t.*, COUNT(pt.post_id) as post_count
       FROM blog_tags t
       LEFT JOIN blog_post_tags pt ON t.id = pt.tag_id
       GROUP BY t.id
       ORDER BY t.name`
    );
    res.json(tags);
  } catch (error) {
    console.error('Failed to fetch tags:', error);
    res.status(500).json({ error: 'Failed to fetch tags' });
  } finally {
    connection.release();
  }
});

// Like a blog post
router.post('/posts/:id/like', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Check if already liked
    const [existingLikes] = await connection.query(
      'SELECT id FROM blog_likes WHERE post_id = ? AND user_id = ?',
      [req.params.id, user_id]
    );

    if (existingLikes.length > 0) {
      return res.status(400).json({ error: 'Post already liked' });
    }

    // Add like
    await connection.query(
      'INSERT INTO blog_likes (id, post_id, user_id) VALUES (UUID(), ?, ?)',
      [req.params.id, user_id]
    );

    // Update like count
    await connection.query(
      'UPDATE blog_posts SET likes = likes + 1 WHERE id = ?',
      [req.params.id]
    );

    res.json({ message: 'Post liked successfully' });
  } catch (error) {
    console.error('Failed to like post:', error);
    res.status(500).json({ error: 'Failed to like post' });
  } finally {
    connection.release();
  }
});

// Add a comment
router.post('/posts/:id/comments', async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const { user_id, content } = req.body;

    if (!user_id || !content) {
      return res.status(400).json({ error: 'User ID and content are required' });
    }

    const id = uuidv4();
    await connection.query(
      'INSERT INTO blog_comments (id, post_id, user_id, content) VALUES (?, ?, ?, ?)',
      [id, req.params.id, user_id, content]
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
      `SELECT c.*, u.email as user_email
       FROM blog_comments c
       LEFT JOIN users u ON c.user_id = u.id
       WHERE c.post_id = ?
       ORDER BY c.created_at DESC`,
      [req.params.id]
    );

    const formattedComments = comments.map(comment => ({
      ...comment,
      created_at: format(new Date(comment.created_at), 'yyyy-MM-dd HH:mm:ss'),
      user: {
        email: comment.user_email,
        name: comment.user_email?.split('@')[0] || 'Anonymous'
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
