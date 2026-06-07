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
    where: { userId: req.user!.id }
  });
  res.json(projects);
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
  const { environment, triggerType } = req.query;
  
  // Find projects belonging to this user
  const userProjects = await prisma.project.findMany({
    where: { userId: req.user!.id },
    select: { id: true }
  });
  const projectIds = userProjects.map(p => p.id);

  const where: any = { projectId: { in: projectIds } };

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

// INGEST Replay
app.post('/api/ingest/replay', async (req, res) => {
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
    },
  });

  res.status(201).json(replay);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`🚀 Production Replay Server listening on port ${PORT}`);
});
