require('dotenv').config();
const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const migrationsRoutes = require('./routes/migrations');
const orgsRoutes = require('./routes/orgs');
const mcpRoutes = require('./routes/mcp');
const generatorRoutes = require('./routes/generator');
const brainRoutes     = require('./routes/brain');
const usersRoutes     = require('./routes/users');
const objectsRoutes   = require('./routes/objects');
const copilotRoutes   = require('./routes/copilot');
const permissionsRoutes = require('./routes/permissions');
const mappingRoutes     = require('./routes/mapping');
const jobsRoutes        = require('./routes/jobs');
const { startReaper } = require('./lib/jobReaper');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || /\.trycloudflare\.com$/.test(new URL(origin).hostname)) {
      callback(null, true);
      return;
    }
    callback(new Error(`CORS blocked origin: ${origin}`));
  },
}));
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
app.use('/api/brain',   brainRoutes);
app.use('/api/users',   usersRoutes);
app.use('/api/objects', objectsRoutes);
app.use('/api/copilot', copilotRoutes);
app.use('/api/permissions', permissionsRoutes);
app.use('/api/mapping',    mappingRoutes);
app.use('/api/jobs',       jobsRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`OrgIQ backend running on http://localhost:${PORT}`);
  startReaper();
});
