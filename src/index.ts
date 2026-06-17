import express from 'express';
import cors from 'cors';
import { PrismaClient } from '@prisma/client';
import { uploadReplayData, fetchReplayData } from './storage/s3';

const prisma = new PrismaClient();
const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-api-key']
}));
app.use(express.json({ limit: '100mb' }));

import authRouter from './api/auth';
import { requireAuth } from './middleware/auth';
app.use('/auth', authRouter);

// Health Check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// GET user's projects
app.get('/api/projects', requireAuth, async (req, res) => {
  const projects = await prisma.project.findMany({
    where: { userId: req.user!.id },
    include: {
      replays: {
        where: {
          capturedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          triggerType: { in: ['uncaught_exception', 'unhandled_rejection', 'http_error'] }
        },
        select: { id: true }
      },
      _count: {
        select: { replays: true }
      }
    }
  });

  const result = projects.map(p => {
    const hasRecentErrors = p.replays.length > 0;
    return {
      id: p.id,
      name: p.name,
      apiKey: p.apiKey,
      userId: p.userId,
      replayCount: p._count.replays,
      isHealthy: !hasRecentErrors
    };
  });

  res.json(result);
});

// Create Project
app.post('/api/projects', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name required' });

  // Generating a standard unique API key
  const apiKey = `pr_live_sk_${Math.random().toString(36).substring(2, 11)}`;
  const project = await prisma.project.create({
    data: { name, apiKey, userId: req.user!.id },
  });

  res.status(201).json(project);
});

// Seed some test data for ease of use
app.post('/api/projects/seed', async (req, res) => {
  const testProject = await prisma.project.findFirst({
    where: { name: 'Test Project' }
  });

  if (testProject) {
    return res.json(testProject);
  }

  const project = await prisma.project.create({
    data: {
      name: 'Test Project',
      apiKey: 'pr_live_sk_a8f3e2d1c4b567890abcdef123456789'
    }
  });

  res.json(project);
});

// GET all replays for user's projects
app.get('/api/replays', requireAuth, async (req, res) => {
  const { environment, triggerType, projectId } = req.query;
  
  // Find projects belonging to this user
  const userProjects = await prisma.project.findMany({
    where: { userId: req.user!.id },
    select: { id: true }
  });
  const projectIds = userProjects.map(p => p.id);

  let targetProjectIds = projectIds;
  if (projectId) {
    const pId = String(projectId);
    if (projectIds.includes(pId)) {
      targetProjectIds = [pId];
    } else {
      return res.status(403).json({ error: 'Forbidden' });
    }
  }

  const where: any = { projectId: { in: targetProjectIds } };

  if (environment) where.environment = String(environment);
  if (triggerType) where.triggerType = String(triggerType);

  const replays = await prisma.replay.findMany({
    where,
    orderBy: { capturedAt: 'desc' },
  });

  res.json(replays);
});

// DELETE all replays for user's projects
app.delete('/api/replays', requireAuth, async (req, res) => {
  try {
    const userProjects = await prisma.project.findMany({
      where: { userId: req.user!.id },
      select: { id: true }
    });
    const projectIds = userProjects.map(p => p.id);

    const result = await prisma.replay.deleteMany({
      where: { projectId: { in: projectIds } }
    });

    res.json({ success: true, count: result.count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete replays' });
  }
});

// GET replay by ID
app.get('/api/replays/:id', requireAuth, async (req, res) => {
  const { id } = req.params;
  const replay = await prisma.replay.findUnique({ 
    where: { id },
    include: { project: true }
  });

  if (!replay) {
    return res.status(404).json({ error: 'Replay not found' });
  }

  // Ensure this replay belongs to a project owned by the user
  if (replay.project.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const data = await fetchReplayData(replay.dataUrl);
    res.json({ ...replay, ...data });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to fetch payload from storage: ${err.message}` });
  }
});

// POST share replay
app.post('/api/replays/:id/share', requireAuth, async (req, res) => {
  const { id } = req.params;
  const replay = await prisma.replay.findUnique({
    where: { id },
    include: { project: true }
  });

  if (!replay) {
    return res.status(404).json({ error: 'Replay not found' });
  }

  if (replay.project.userId !== req.user!.id) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const crypto = await import('crypto');
  const shareToken = crypto.randomUUID();
  const shareExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const updated = await prisma.replay.update({
    where: { id },
    data: { shareToken, shareExpiresAt }
  });

  res.json({ shareToken: updated.shareToken, shareExpiresAt: updated.shareExpiresAt });
});

// GET public shared replay by share token
app.get('/api/public/replays/:shareToken', async (req, res) => {
  const { shareToken } = req.params;
  const replay = await prisma.replay.findUnique({
    where: { shareToken },
    include: { project: true }
  });

  if (!replay) {
    return res.status(404).json({ error: 'Shared replay not found' });
  }

  if (replay.shareExpiresAt && replay.shareExpiresAt < new Date()) {
    return res.status(410).json({ error: 'Shared link has expired' });
  }

  try {
    const data = await fetchReplayData(replay.dataUrl);
    res.json({ ...replay, ...data });
  } catch (err: any) {
    res.status(500).json({ error: `Failed to fetch payload from storage: ${err.message}` });
  }
});


// GET trace replays by trace ID
app.get('/api/replays/:id/trace', requireAuth, async (req, res) => {
  const { id } = req.params;
  const sourceReplay = await prisma.replay.findUnique({ 
    where: { id },
    select: { traceId: true, projectId: true, project: { select: { userId: true } } }
  });

  if (!sourceReplay) return res.status(404).json({ error: 'Replay not found' });
  if (sourceReplay.project.userId !== req.user!.id) return res.status(403).json({ error: 'Forbidden' });
  if (!sourceReplay.traceId) return res.json([]);

  const traceReplays = await prisma.replay.findMany({
    where: { 
      traceId: sourceReplay.traceId,
      project: { userId: req.user!.id }
    },
    orderBy: { capturedAt: 'asc' }
  });

  res.json(traceReplays);
});

// Verify API Key
app.get('/api/ingest/verify', async (req, res) => {
  const apiKeyHeader = req.headers['x-api-key'] || req.headers['authorization'];
  if (!apiKeyHeader) return res.status(401).json({ error: 'Unauthorized: missing API Key' });

  const apiKey = String(apiKeyHeader).replace('Bearer ', '');
  const project = await prisma.project.findUnique({ where: { apiKey } });

  if (!project) {
    return res.status(401).json({ error: 'Unauthorized: invalid API Key' });
  }

  res.json({ success: true, project: project.name });
});

import { rateLimit } from 'express-rate-limit';

const ingestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: { error: 'Too many requests, please try again later.' }
});

// INGEST Replay
app.post('/api/ingest/replay', ingestLimiter, async (req, res) => {
  const apiKeyHeader = req.headers['x-api-key'] || req.headers['authorization'];
  if (!apiKeyHeader) return res.status(401).json({ error: 'Unauthorized: missing API Key' });

  const apiKey = String(apiKeyHeader).replace('Bearer ', '');
  const project = await prisma.project.findUnique({ where: { apiKey } });

  if (!project) {
    return res.status(401).json({ error: 'Unauthorized: invalid API Key' });
  }

  const {
    id,
    triggerType,
    triggerLabel,
    errorMessage,
    errorStack,
    serviceName,
    environment,
    durationMs,
    eventCount,
    events,
    httpCaptures,
    dbQueries,
    traceId,
    severity,
    sdkVersion,
  } = req.body;

  if (!triggerType || !serviceName || !events) {
    return res.status(400).json({ error: 'Missing required payload parameters' });
  }

  const replayId = id || `rpl-${Math.random().toString(36).substring(2, 11)}`;

  // Complete payload to save in S3 / disk
  const payloadData = { events, httpCaptures: httpCaptures || [], dbQueries: dbQueries || [] };
  const dataUrl = await uploadReplayData(replayId, payloadData);

  // Save metadata to database
  const replay = await prisma.replay.create({
    data: {
      id: replayId,
      projectId: project.id,
      triggerType,
      triggerLabel,
      errorMessage,
      errorStack,
      serviceName,
      environment: environment || 'production',
      traceId,
      durationMs: durationMs || 0,
      eventCount: eventCount || events.length,
      dataUrl,
      severity: severity || null,
      sdkVersion: sdkVersion || null,
    },
  });

  res.status(201).json(replay);
});

// ─── DASHBOARD STATS ────────────────────────────────────────────────────────
// GET /api/stats?range=7d  — returns all data needed by the Dashboard page
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const range = String(req.query.range || '7d');
    const { projectId } = req.query;
    const days = range === '24h' ? 1 : range === '30d' ? 30 : 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const prevSince = new Date(since.getTime() - days * 24 * 60 * 60 * 1000);

    // All projects belonging to user
    const userProjects = await prisma.project.findMany({
      where: { userId: req.user!.id },
      select: { id: true },
    });
    const projectIds = userProjects.map((p) => p.id);

    let targetProjectIds = projectIds;
    if (projectId) {
      const pId = String(projectId);
      if (projectIds.includes(pId)) {
        targetProjectIds = [pId];
      } else {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    if (targetProjectIds.length === 0) {
      return res.json({
        totalReplays: 0, prevTotalReplays: 0,
        errorRate: 0, prevErrorRate: 0,
        p95ResponseTime: 0, prevP95ResponseTime: 0,
        avgResolveTime: 0,
        replaysByDay: [], triggerBreakdown: [],
        topEndpoints: [], responseTimeBuckets: [], dbQueryPerf: [],
      });
    }

    const where = { projectId: { in: targetProjectIds }, capturedAt: { gte: since } };
    const prevWhere = { projectId: { in: targetProjectIds }, capturedAt: { gte: prevSince, lt: since } };

    const [current, previous] = await Promise.all([
      prisma.replay.findMany({ where }),
      prisma.replay.findMany({ where: prevWhere, select: { triggerType: true, durationMs: true } }),
    ]);

    // ── Total replays ──────────────────────────────────────────────────────
    const totalReplays = current.length;
    const prevTotalReplays = previous.length;

    // ── Error rate ────────────────────────────────────────────────────────
    const isError = (r: { triggerType: string }) =>
      r.triggerType === 'uncaught_exception' || r.triggerType === 'unhandled_rejection' || r.triggerType === 'http_error';
    const errorRate = totalReplays > 0 ? (current.filter(isError).length / totalReplays) * 100 : 0;
    const prevErrorRate = previous.length > 0 ? (previous.filter(isError).length / previous.length) * 100 : 0;

    // ── P95 response time ─────────────────────────────────────────────────
    const durations = current.map((r) => r.durationMs).sort((a, b) => a - b);
    const p95idx = Math.floor(durations.length * 0.95);
    const p95ResponseTime = durations[p95idx] ?? 0;
    const prevDurations = previous.map((r) => r.durationMs).sort((a, b) => a - b);
    const prevP95ResponseTime = prevDurations[Math.floor(prevDurations.length * 0.95)] ?? 0;

    // ── Avg resolve time (minutes between capture and first view) ─────────
    // Placeholder: will be computed when "viewed_at" is tracked
    const avgResolveTime = 0;

    // ── Replays by day (for line chart) ───────────────────────────────────
    const dayMap: Record<string, { total: number; errors: number; label: string }> = {};
    for (let i = 0; i < days; i++) {
      const d = new Date(since.getTime() + i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const label = days === 1
        ? `${d.getHours()}:00`
        : d.toLocaleDateString('en-US', { weekday: 'short', month: 'numeric', day: 'numeric' });
      dayMap[key] = { total: 0, errors: 0, label };
    }
    current.forEach((r) => {
      const key = new Date(r.capturedAt).toISOString().slice(0, 10);
      if (dayMap[key]) {
        dayMap[key].total++;
        if (isError(r)) dayMap[key].errors++;
      }
    });
    const replaysByDay = Object.values(dayMap);

    // ── Trigger breakdown (for doughnut) ──────────────────────────────────
    const triggerMap: Record<string, number> = {};
    current.forEach((r) => {
      triggerMap[r.triggerType] = (triggerMap[r.triggerType] || 0) + 1;
    });
    const triggerBreakdown = Object.entries(triggerMap).map(([type, count]) => ({ type, count }));

    // ── Top error endpoints (from triggerLabel / errorMessage) ────────────
    const endpointMap: Record<string, number> = {};
    current.filter(isError).forEach((r) => {
      const ep = r.triggerLabel || r.errorMessage || 'unknown';
      const key = ep.length > 40 ? ep.slice(0, 40) + '…' : ep;
      endpointMap[key] = (endpointMap[key] || 0) + 1;
    });
    const topEndpoints = Object.entries(endpointMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([endpoint, count]) => ({ endpoint, count }));

    // ── Response time buckets (for bar chart) ─────────────────────────────
    const buckets = [
      { label: '<50ms',     min: 0,    max: 50,   count: 0 },
      { label: '50-200ms',  min: 50,   max: 200,  count: 0 },
      { label: '200-500ms', min: 200,  max: 500,  count: 0 },
      { label: '500ms-1s',  min: 500,  max: 1000, count: 0 },
      { label: '>1s',       min: 1000, max: Infinity, count: 0 },
    ];
    current.forEach((r) => {
      const b = buckets.find((b) => r.durationMs >= b.min && r.durationMs < b.max);
      if (b) b.count++;
    });
    const responseTimeBuckets = buckets.map(({ label, count }) => ({ label, count }));

    // ── DB query perf — placeholder (needs dbQueries in replay payload) ───
    const dbQueryPerf: { table: string; avgMs: number }[] = [];

    res.json({
      totalReplays, prevTotalReplays,
      errorRate: Math.round(errorRate * 10) / 10,
      prevErrorRate: Math.round(prevErrorRate * 10) / 10,
      p95ResponseTime, prevP95ResponseTime,
      avgResolveTime,
      replaysByDay, triggerBreakdown, topEndpoints,
      responseTimeBuckets, dbQueryPerf,
    });
  } catch (err: any) {
    console.error('Stats error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Production Replay Server listening on port ${PORT}`);
});

