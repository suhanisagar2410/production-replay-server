import { PrismaClient } from '@prisma/client';

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.project.findFirst({
      where: { apiKey: 'pr_live_sk_a8f3e2d1c4b567890abcdef123456789' }
    });
    if (existing) {
      console.log('Project already exists with this key.');
    } else {
      const p = await prisma.project.create({
        data: {
          name: 'Test Project',
          apiKey: 'pr_live_sk_a8f3e2d1c4b567890abcdef123456789'
        }
      });
      console.log('Successfully seeded project:', p);
    }
  } catch (err: any) {
    console.error('Error seeding:', err.message);
  } finally {
    await prisma.$disconnect();
  }
}

main();
