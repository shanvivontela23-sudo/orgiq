'use strict';
/**
 * routes/brain.js
 * Brain (persistent memory) API for OrgIQ.
 * Mount at: app.use('/api/brain', require('./routes/brain'));
 */

const express = require('express');
const router  = express.Router();
const { remember, recall, listMemories, forget, buildContext } = require('../lib/brain');

/**
 * GET /api/brain/memories
 * List all memories for a user (for the memory panel UI).
 */
router.get('/memories', async (req, res) => {
  const { userId, orgId, type } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const memories = await listMemories({ userId, orgId, type });
  res.json({ memories });
});

/**
 * POST /api/brain/recall
 * Retrieve relevant memories for a given query.
 * Used by the frontend to preview what the brain knows before a migration run.
 */
router.post('/recall', async (req, res) => {
  const { userId, orgId, query, type, limit = 6 } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const memories = await recall({ userId, orgId, query, type, limit });
  res.json({ memories });
});

/**
 * POST /api/brain/context
 * Returns the formatted brain context string — same thing injected into Claude.
 * Useful for the frontend "brain indicator" to show what Claude knows.
 */
router.post('/context', async (req, res) => {
  const { userId, orgId, query } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const context = await buildContext({ userId, orgId, query });
  res.json({ context, hasMemories: context.length > 0 });
});

/**
 * POST /api/brain/remember
 * Manually store a memory (for future: user can add notes).
 */
router.post('/remember', async (req, res) => {
  const { userId, orgId, type, subject, content, importance, keywords } = req.body;
  if (!userId || !type || !subject || !content) {
    return res.status(400).json({ error: 'userId, type, subject, content required' });
  }
  await remember({ userId, orgId, type, subject, content, importance, keywords });
  res.json({ ok: true });
});

/**
 * DELETE /api/brain/memories/:id
 * Delete a specific memory (user can remove incorrect learnings).
 */
router.delete('/memories/:id', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await forget({ memoryId: req.params.id, userId });
  res.json({ ok: true });
});

module.exports = router;
