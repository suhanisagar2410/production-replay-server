import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding dummy data...');

  let project = await prisma.project.findFirst();
  if (!project) {
    let user = await prisma.user.findFirst();
    if (!user) {
      user = await prisma.user.create({
        data: { name: 'Demo User', email: 'demo@example.com' }
      });
    }
    project = await prisma.project.create({
      data: {
        name: 'Demo App',
        apiKey: 'demo_' + Date.now().toString(),
        userId: user.id
      }
    });
    console.log(`Created new dummy project: ${project.name}`);
  }

  const now = new Date();
  
  const commonErrors = [
    {
      triggerType: 'uncaught_exception',
      errorMessage: "TypeError: Cannot read properties of undefined (reading 'map')",
      errorFingerprint: 'type_error_map',
      serviceName: 'frontend-web',
      severity: 'critical'
    },
    {
      triggerType: 'unhandled_rejection',
      errorMessage: "Query took 1200ms on table 'analytics'",
      errorFingerprint: 'slow_query_analytics',
      serviceName: 'reporting-worker',
      severity: 'warning'
    },
    {
      triggerType: 'http_error',
      errorMessage: "500 Internal Server Error: Connection reset by peer",
      errorFingerprint: 'http_500_conn_reset',
      serviceName: 'api-gateway',
      severity: 'error'
    },
    {
      triggerType: 'uncaught_exception',
      errorMessage: "ReferenceError: process is not defined",
      errorFingerprint: 'ref_error_process',
      serviceName: 'frontend-web',
      severity: 'error'
    },
    {
      triggerType: 'manual',
      errorMessage: "User reported: checkout button unresponsive",
      errorFingerprint: null,
      serviceName: 'frontend-web',
      severity: 'info'
    }
  ];

  const totalToCreate = 150;
  let created = 0;

  for (let i = 0; i < totalToCreate; i++) {
    // Pick a random day in the last 14 days (weighted slightly towards recent days)
    const daysAgo = Math.floor(Math.pow(Math.random(), 1.5) * 14); 
    const capturedAt = new Date(now.getTime() - (daysAgo * 24 * 60 * 60 * 1000) - (Math.random() * 24 * 60 * 60 * 1000));
    
    // Pick a random error type
    const errObj = commonErrors[Math.floor(Math.random() * commonErrors.length)];
    
    await prisma.replay.create({
      data: {
        projectId: project.id,
        triggerType: errObj.triggerType,
        triggerLabel: errObj.triggerType === 'manual' ? 'User Feedback' : 'Exception',
        errorMessage: errObj.errorMessage,
        errorFingerprint: errObj.errorFingerprint,
        serviceName: errObj.serviceName,
        severity: errObj.severity,
        environment: 'production',
        durationMs: Math.floor(Math.random() * 15000) + 1000,
        eventCount: Math.floor(Math.random() * 300) + 50,
        capturedAt,
        dataUrl: 'dummy.json',
        status: Math.random() > 0.8 ? 'Resolved' : 'New',
        releaseVersion: Math.random() > 0.5 ? 'v2.3.1' : 'v2.3.0',
        commitSha: Math.random() > 0.5 ? 'a7f3d9c2' : 'b4e1a8f9',
      }
    });
    created++;
    if (created % 25 === 0) console.log(`Created ${created} replays...`);
  }

  console.log(`Successfully seeded ${created} dummy replays!`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
