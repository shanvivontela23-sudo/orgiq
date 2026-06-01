require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const migrationsRoutes = require('./routes/migrations');
const orgsRoutes = require('./routes/orgs');
const mcpRoutes = require('./routes/mcp');
const generatorRoutes = require('./routes/generator');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({ origin: process.env.FRONTEND_URL || 'http://localhost:5173' }));
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Routes
app.use('/auth', authRoutes);
app.use('/api/migrations', migrationsRoutes);
app.use('/api/orgs', orgsRoutes);
app.use('/api/mcp', mcpRoutes);
app.use('/api/generate', generatorRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`OrgIQ backend running on http://localhost:${PORT}`);
});
