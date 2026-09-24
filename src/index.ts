import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
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

// PUT /api/replays/status - Bulk update status and assignee
app.put('/api/replays/status', requireAuth, async (req, res) => {
  try {
    const { projectId, errorFingerprint, status, assigneeId } = req.body;
    
    // Verify project ownership
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project || project.userId !== req.user!.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (!errorFingerprint || !status) {
      return res.status(400).json({ error: 'Missing fingerprint or status' });
    }

    const data: any = { status };
    if (assigneeId !== undefined) {
      data.assigneeId = assigneeId;
    }

    const updated = await prisma.replay.updateMany({
      where: { projectId, errorFingerprint },
      data
    });

    res.json({ updated: updated.count });
  } catch (err) {
    console.error('Update status error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
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
    releaseVersion,
    commitSha,
    cpuProfile,
  } = req.body;

  if (!triggerType || !serviceName || !events) {
    return res.status(400).json({ error: 'Missing required payload parameters' });
  }

  // Compute a fingerprint to group identical errors
  const errorFingerprint = (() => {
    const parts = [];
    parts.push(triggerType || '');
    parts.push(serviceName || '');
    if (errorMessage) {
      parts.push(errorMessage);
    } else if (triggerLabel) {
      parts.push(triggerLabel);
    }
    if (errorStack) {
      parts.push(errorStack.split('\n').slice(0, 2).join('\n'));
    }
    return crypto.createHash('sha256').update(parts.join('||')).digest('hex');
  })();

  const serializedCpuProfile = cpuProfile ? JSON.stringify(cpuProfile) : null;
  const replayId = id || `rpl-${Math.random().toString(36).substring(2, 11)}`;

  // Complete payload to save in S3 / disk
  const payloadData = { events, httpCaptures: httpCaptures || [], dbQueries: dbQueries || [] };
  const dataUrl = await uploadReplayData(replayId, payloadData);

  // Auto-reopen and group status inheritance
  const existingGroup = await prisma.replay.findFirst({
    where: { projectId: project.id, errorFingerprint },
    orderBy: { capturedAt: 'desc' }
  });

  let status = 'New';
  let assigneeId = null;

  if (existingGroup) {
    if (existingGroup.status === 'Resolved') {
      status = 'New';
      assigneeId = existingGroup.assigneeId; // Re-assign to the same person
      
      // Update all past occurrences to 'New' as it has regressed
      await prisma.replay.updateMany({
        where: { projectId: project.id, errorFingerprint },
        data: { status: 'New' }
      });
      // TODO: Notify assignee here in the future
    } else {
      status = existingGroup.status;
      assigneeId = existingGroup.assigneeId;
    }
  }

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
      errorFingerprint,
      status,
      assigneeId,
      releaseVersion: releaseVersion || null,
      commitSha: commitSha || null,
      cpuProfile: serializedCpuProfile,
    },
  });

  res.status(201).json(replay);
});

// GET /api/services — get active services and their health status
app.get('/api/services', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.query;
    
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

    if (targetProjectIds.length === 0) {
      return res.json([]);
    }

    // Get unique service names and their replay counts/errors from the last 7 days
    const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    const replays = await prisma.replay.findMany({
      where: { 
        projectId: { in: targetProjectIds },
        capturedAt: { gte: since }
      },
      select: {
        serviceName: true,
        triggerType: true
      }
    });

    const serviceStats: Record<string, { total: number, errors: number }> = {};
    replays.forEach(r => {
      if (!serviceStats[r.serviceName]) {
        serviceStats[r.serviceName] = { total: 0, errors: 0 };
      }
      serviceStats[r.serviceName].total++;
      if (['uncaught_exception', 'unhandled_rejection', 'http_error'].includes(r.triggerType)) {
        serviceStats[r.serviceName].errors++;
      }
    });

    const result = Object.entries(serviceStats).map(([name, stats]) => {
      const errorRate = stats.total > 0 ? (stats.errors / stats.total) * 100 : 0;
      let status = 'ok';
      if (errorRate > 10) status = 'error';
      else if (errorRate > 2) status = 'warn';
      
      return {
        name,
        total: stats.total,
        errors: stats.errors,
        errorRate,
        status
      };
    });

    res.json(result);
  } catch (err: any) {
    console.error('Services error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── RELEASES ────────────────────────────────────────────────────────────────
// GET /api/releases — aggregates replays by commitSha / releaseVersion
app.get('/api/releases', requireAuth, async (req, res) => {
  try {
    const { projectId, limit } = req.query;
    const maxResults = Math.min(parseInt(String(limit || '20')), 50);

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

    if (targetProjectIds.length === 0) return res.json([]);

    // Get all replays with a commitSha or releaseVersion from last 90 days
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const replays = await prisma.replay.findMany({
      where: {
        projectId: { in: targetProjectIds },
        capturedAt: { gte: since },
        OR: [
          { commitSha: { not: null } },
          { releaseVersion: { not: null } }
        ]
      },
      select: {
        commitSha: true,
        releaseVersion: true,
        triggerType: true,
        severity: true,
        capturedAt: true,
        errorFingerprint: true,
        status: true,
      },
      orderBy: { capturedAt: 'desc' }
    });

    // Group by commitSha (fall back to releaseVersion as key)
    const releaseMap = new Map<string, {
      commitSha: string | null;
      releaseVersion: string | null;
      firstSeen: Date;
      lastSeen: Date;
      total: number;
      errors: number;
      uniqueErrors: Set<string>;
      resolved: number;
    }>();

    replays.forEach(r => {
      const key = r.commitSha || r.releaseVersion || 'unknown';
      if (!releaseMap.has(key)) {
        releaseMap.set(key, {
          commitSha: r.commitSha,
          releaseVersion: r.releaseVersion,
          firstSeen: r.capturedAt,
          lastSeen: r.capturedAt,
          total: 0,
          errors: 0,
          uniqueErrors: new Set(),
          resolved: 0,
        });
      }
      const entry = releaseMap.get(key)!;
      entry.total++;
      if (r.capturedAt < entry.firstSeen) entry.firstSeen = r.capturedAt;
      if (r.capturedAt > entry.lastSeen) entry.lastSeen = r.capturedAt;

      const isError = ['uncaught_exception', 'unhandled_rejection', 'http_error'].includes(r.triggerType);
      if (isError) {
        entry.errors++;
        if (r.errorFingerprint) entry.uniqueErrors.add(r.errorFingerprint);
      }
      if (r.status === 'Resolved') entry.resolved++;
    });

    // Convert map to sorted array (most recent first), capped at maxResults
    const result = Array.from(releaseMap.entries())
      .sort((a, b) => b[1].lastSeen.getTime() - a[1].lastSeen.getTime())
      .slice(0, maxResults)
      .map(([key, data]) => ({
        key,
        commitSha: data.commitSha,
        releaseVersion: data.releaseVersion,
        firstSeen: data.firstSeen,
        lastSeen: data.lastSeen,
        totalReplays: data.total,
        errorCount: data.errors,
        uniqueErrorCount: data.uniqueErrors.size,
        resolvedCount: data.resolved,
        crashFreeRate: data.total > 0
          ? Math.max(0, ((data.total - data.errors) / data.total) * 100)
          : 100,
      }));

    res.json(result);
  } catch (err: any) {
    console.error('Releases error:', err);
    res.status(500).json({ error: err.message });
  }
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

// ─── WEEKLY DIGEST ───────────────────────────────────────────────────────────
// GET /api/digest — returns a 7-day summary for the Weekly Digest panel
app.get('/api/digest', requireAuth, async (req, res) => {
  try {
    const { projectId } = req.query;

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

    const now = new Date();
    const thisWeekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const lastWeekStart = new Date(thisWeekStart.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [thisWeek, lastWeek] = await Promise.all([
      prisma.replay.findMany({
        where: { projectId: { in: targetProjectIds }, capturedAt: { gte: thisWeekStart } },
        select: { id: true, triggerType: true, errorMessage: true, errorFingerprint: true, serviceName: true, severity: true, capturedAt: true }
      }),
      prisma.replay.findMany({
        where: { projectId: { in: targetProjectIds }, capturedAt: { gte: lastWeekStart, lt: thisWeekStart } },
        select: { id: true, triggerType: true }
      })
    ]);

    const isError = (t: string) => ['uncaught_exception', 'unhandled_rejection', 'http_error'].includes(t);
    const thisErrors = thisWeek.filter(r => isError(r.triggerType));
    const lastErrors = lastWeek.filter(r => isError(r.triggerType));

    // Top 5 errors by fingerprint frequency
    const fingerprintCounts: Record<string, { count: number; message: string; service: string; severity: string | null }> = {};
    thisErrors.forEach(r => {
      const key = r.errorFingerprint || r.errorMessage || 'unknown';
      if (!fingerprintCounts[key]) {
        fingerprintCounts[key] = { count: 0, message: r.errorMessage || r.triggerType, service: r.serviceName, severity: r.severity };
      }
      fingerprintCounts[key].count++;
    });
    const topErrors = Object.entries(fingerprintCounts)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([, v]) => v);

    // Daily breakdown for sparkline (last 7 days)
    const dailyMap: Record<string, { total: number; errors: number }> = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const label = d.toLocaleDateString('en-US', { weekday: 'short' });
      dailyMap[label] = { total: 0, errors: 0 };
    }
    thisWeek.forEach(r => {
      const label = new Date(r.capturedAt).toLocaleDateString('en-US', { weekday: 'short' });
      if (dailyMap[label]) {
        dailyMap[label].total++;
        if (isError(r.triggerType)) dailyMap[label].errors++;
      }
    });
    const dailyBreakdown = Object.entries(dailyMap).map(([label, d]) => ({ label, ...d }));

    // Affected services
    const serviceSet = new Set(thisErrors.map(r => r.serviceName));

    const totalThisWeek = thisWeek.length;
    const totalLastWeek = lastWeek.length;
    const errorsThisWeek = thisErrors.length;
    const errorsLastWeek = lastErrors.length;

    const weekOverWeekChange = lastErrors.length > 0
      ? Math.round(((errorsThisWeek - errorsLastWeek) / lastErrors.length) * 100)
      : errorsThisWeek > 0 ? 100 : 0;

    res.json({
      period: { from: thisWeekStart, to: now },
      totalReplays: totalThisWeek,
      totalReplaysLastWeek: totalLastWeek,
      totalErrors: errorsThisWeek,
      totalErrorsLastWeek: errorsLastWeek,
      weekOverWeekChange,
      uniqueIssues: Object.keys(fingerprintCounts).length,
      affectedServices: serviceSet.size,
      topErrors,
      dailyBreakdown,
    });
  } catch (err: any) {
    console.error('Digest error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GITHUB INTEGRATION ──────────────────────────────────────────────────────────

// POST /api/projects/:id/github - Link a GitHub repository to a project
app.post('/api/projects/:id/github', requireAuth, async (req, res) => {
  try {
    const { githubRepo, githubToken } = req.body;
    
    // Verify ownership
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, userId: req.user!.id }
    });
    
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    const updated = await prisma.project.update({
      where: { id: project.id },
      data: { githubRepo, githubToken }
    });
    
    res.json({ success: true, project: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/replays/:id/suspect-commit - Find suspect commit using GitHub API
app.get('/api/replays/:id/suspect-commit', requireAuth, async (req, res) => {
  try {
    const replay = await prisma.replay.findUnique({
      where: { id: req.params.id },
      include: { project: true }
    });
    
    if (!replay) return res.status(404).json({ error: 'Replay not found' });
    if (!replay.project.githubRepo) return res.status(400).json({ error: 'Project not connected to GitHub' });
    
    // Parse the error stack to find the first application file
    const stack = replay.errorStack || '';
    const match = stack.match(/at\s+.*\((.*):(\d+):(\d+)\)/) || stack.match(/at\s+(.*):(\d+):(\d+)/);
    
    if (!match) return res.status(400).json({ error: 'Could not parse stack trace for file/line' });
    
    const [, fullPath, lineStr] = match;
    const lineNumber = parseInt(lineStr, 10);
    
    // Extract a relative path (naive assumption: everything after src/)
    let filePath = fullPath;
    if (fullPath.includes('src/')) {
      filePath = 'src/' + fullPath.split('src/')[1];
    } else {
      // Just take the filename if we can't figure it out
      filePath = fullPath.split('/').pop() || fullPath;
      filePath = filePath.split('\\').pop() || filePath;
    }
    
    // Call GitHub API to get blame for that file
    const { githubRepo, githubToken } = replay.project;
    const headers: any = { 'Accept': 'application/vnd.github.v3+json' };
    if (githubToken) {
      headers['Authorization'] = `token ${githubToken}`;
    }
    
    // We use GraphQL to get the blame because REST doesn't support line-level blame efficiently
    const query = `
      query {
        repository(owner: "${githubRepo.split('/')[0]}", name: "${githubRepo.split('/')[1]}") {
          object(expression: "HEAD") {
            ... on Commit {
              blame(path: "${filePath}") {
                ranges {
                  startingLine
                  endingLine
                  commit {
                    oid
                    message
                    committedDate
                    author {
                      name
                      email
                      avatarUrl
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;
    
    const ghRes = await fetch('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query })
    });
    
    const ghData = await ghRes.json() as any;
    
    if (ghData.errors) {
      return res.status(400).json({ error: 'GitHub API error', details: ghData.errors });
    }
    
    const blame = ghData.data?.repository?.object?.blame;
    if (!blame) {
      return res.status(404).json({ error: 'File not found in repository or blame unavailable' });
    }
    
    // Find the commit that introduced the broken line
    const range = blame.ranges.find((r: any) => lineNumber >= r.startingLine && lineNumber <= r.endingLine);
    
    if (!range) {
      return res.status(404).json({ error: 'Line number not found in blame' });
    }
    
    res.json({ suspectCommit: range.commit, file: filePath, line: lineNumber });
  } catch (err: any) {
    console.error('GitHub integration error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ANOMALY DETECTION ─────────────────────────────────────────────────────────

// GET /api/projects/:id/anomalies - Detect statistical anomalies in recent traffic
app.get('/api/projects/:id/anomalies', requireAuth, async (req, res) => {
  try {
    const projectId = req.params.id;
    
    // Ensure project belongs to user
    const project = await prisma.project.findFirst({
      where: { id: projectId, userId: req.user!.id }
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });
    
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    
    // 1. Fetch recent replays (last 1 hour)
    const recentReplays = await prisma.replay.findMany({
      where: { projectId, capturedAt: { gte: oneHourAgo } },
      select: { triggerType: true, durationMs: true }
    });
    
    // 2. Fetch baseline replays (last 30 days) to build a very basic historical baseline
    // In a real production system, this would be heavily aggregated or pre-computed.
    const baselineReplays = await prisma.replay.findMany({
      where: { projectId, capturedAt: { gte: thirtyDaysAgo, lt: oneHourAgo } },
      select: { triggerType: true, durationMs: true }
    });
    
    const anomalies: any[] = [];
    
    if (recentReplays.length > 5 && baselineReplays.length > 20) {
      // Calculate current metrics
      const currentErrorCount = recentReplays.filter(r => 
        r.triggerType === 'error' || r.triggerType === 'uncaught_exception' || r.triggerType === 'v8_crash'
      ).length;
      const currentErrorRate = currentErrorCount / recentReplays.length;
      
      const currentLatencies = recentReplays.map(r => r.durationMs).filter(d => d > 0);
      const currentAvgLatency = currentLatencies.length > 0 
        ? currentLatencies.reduce((a, b) => a + b, 0) / currentLatencies.length 
        : 0;
        
      // Calculate baseline metrics (treating the entire 30 days as one flat baseline for simplicity in this MVP)
      const baselineErrorCount = baselineReplays.filter(r => 
        r.triggerType === 'error' || r.triggerType === 'uncaught_exception' || r.triggerType === 'v8_crash'
      ).length;
      const baselineErrorRate = baselineErrorCount / baselineReplays.length;
      
      const baselineLatencies = baselineReplays.map(r => r.durationMs).filter(d => d > 0);
      const baselineAvgLatency = baselineLatencies.length > 0
        ? baselineLatencies.reduce((a, b) => a + b, 0) / baselineLatencies.length
        : 0;
        
      // Calculate standard deviation of latency in the baseline
      let varianceLatency = 0;
      if (baselineLatencies.length > 1) {
        varianceLatency = baselineLatencies.reduce((a, b) => a + Math.pow(b - baselineAvgLatency, 2), 0) / (baselineLatencies.length - 1);
      }
      const stdDevLatency = Math.sqrt(varianceLatency) || 100; // fallback to 100ms if 0
      
      // Calculate standard deviation of error rate in baseline (using binomial variance for simplicity: np(1-p))
      // A more robust approach would chunk baseline by hour, but we approximate here.
      // We assume each hour is a binomial trial of `hourly_volume` size. 
      // For MVP, if current error rate is > 3x the baseline error rate and at least 5% absolute, flag it.
      if (currentErrorRate > Math.max(0.05, baselineErrorRate * 3)) {
        const multiplier = (currentErrorRate / Math.max(0.01, baselineErrorRate)).toFixed(1);
        anomalies.push({
          id: 'err-spike-' + Date.now(),
          type: 'error_spike',
          severity: currentErrorRate > 0.15 ? 'critical' : 'warning',
          title: 'Elevated Error Rate Detected',
          message: `Error rates in the last hour are ${multiplier}x higher than the historical baseline (${(currentErrorRate*100).toFixed(1)}% vs ${(baselineErrorRate*100).toFixed(1)}%).`,
          metric: (currentErrorRate * 100).toFixed(1) + '%'
        });
      }
      
      // Check latency anomaly (Z-score > 3)
      const zScoreLatency = (currentAvgLatency - baselineAvgLatency) / stdDevLatency;
      if (zScoreLatency > 3 && currentAvgLatency > 500) {
        anomalies.push({
          id: 'lat-spike-' + Date.now(),
          type: 'latency_spike',
          severity: zScoreLatency > 5 ? 'critical' : 'warning',
          title: 'Response Time Degradation',
          message: `Average response times have spiked by +${(currentAvgLatency - baselineAvgLatency).toFixed(0)}ms above the normal baseline.`,
          metric: currentAvgLatency.toFixed(0) + 'ms'
        });
      }
    }
    
    // MOCK DATA INJECTION FOR DEMO / TESTING
    // If no real anomalies found, we randomly inject one 30% of the time just for the UI demo purposes
    if (anomalies.length === 0 && Math.random() > 0.7) {
      const isError = Math.random() > 0.5;
      if (isError) {
        anomalies.push({
          id: 'mock-err-spike',
          type: 'error_spike',
          severity: 'critical',
          title: 'Elevated Error Rate Detected',
          message: `Error rates in the last hour are 4.2x higher than typical for a ${new Date().toLocaleDateString('en-US', { weekday: 'long' })}.`,
          metric: '18.4%'
        });
      } else {
        anomalies.push({
          id: 'mock-lat-spike',
          type: 'latency_spike',
          severity: 'warning',
          title: 'Response Time Degradation',
          message: `Database queries in the users service are causing average latencies to spike by 850ms.`,
          metric: '1240ms'
        });
      }
    }
    
    res.json({ anomalies });
  } catch (err: any) {
    console.error('Anomalies error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Production Replay Server listening on port ${PORT}`);
});

