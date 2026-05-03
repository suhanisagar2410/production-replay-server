import express from 'express';
import { replay } from './sdk/index';

const app = express();
app.use(express.json());

// Initialize the SDK using our seeded test project API Key
replay.init({
  apiKey: 'pr_live_sk_a8f3e2d1c4b567890abcdef123456789',
  apiUrl: 'http://localhost:4000',
  serviceName: 'demo-express-service',
  environment: 'production',
});

// Attach incoming request tracker middleware
app.use(replay.expressMiddleware());

// Standard routes
app.get('/', (req, res) => {
  replay.recordEvent('function_call', { name: 'handleIndex', file: 'demo-app.ts', line: 18 });
  res.send('Welcome to the Production Replay Demo App!');
});

// Outbound API simulation
app.get('/api/users/:id', (req, res) => {
  const userId = req.params.id;

  // Add dummy variable state
  replay.recordEvent('function_call', { name: 'fetchUser', file: 'demo-app.ts', line: 26, args: { userId } });

  // Simulate outgoing database query trace
  replay.recordEvent('db_query_start', { sql: 'SELECT * FROM users WHERE id = $1', params: [userId], dbType: 'postgresql' });

  setTimeout(() => {
    replay.recordEvent('db_query_end', { duration: 12, rowCount: 1, sql: 'SELECT * FROM users WHERE id = $1' });
    res.json({ id: userId, name: 'Suhani', email: 'suhani@example.com' });
  }, 50);
});

// Route to intentionally trigger an uncaught error
app.get('/trigger-error', (req, res) => {
  replay.recordEvent('function_call', { name: 'handleErrorRoute', file: 'demo-app.ts', line: 41 });

  // Manual trace before error
  replay.recordEvent('db_query_start', { sql: 'UPDATE users SET last_active = NOW() WHERE id = $1', params: ['123'], dbType: 'postgresql' });

  setTimeout(() => {
    replay.recordEvent('db_query_end', { duration: 15, rowCount: 1, sql: 'UPDATE users SET last_active = NOW() WHERE id = $1' });

    // Raising intentional error
    const err = new Error('Database transaction failed: Duplicate key violation on unique index');
    replay.capture(err, 'uncaught_exception');

    res.status(500).json({ error: err.message });
  }, 40);
});

const PORT = 5050;
app.listen(PORT, () => {
  console.log(`🎯 Test Demo Express App is listening on port ${PORT}`);
  console.log(`   --> Open http://localhost:${PORT}/ to trace initial events`);
  console.log(`   --> Open http://localhost:${PORT}/api/users/123 to trace user requests & db events`);
  console.log(`   --> Open http://localhost:${PORT}/trigger-error to trigger an error & upload a replay to dashboard`);
});
