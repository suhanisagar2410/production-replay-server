const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.project.findFirst().then(p => { console.log("API_KEY=" + p?.apiKey); process.exit(0); });
