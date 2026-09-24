import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  await prisma.project.updateMany({
    data: { userId: '7bd3d77e-30b6-4b4e-a59c-17b48dcbda7f' }
  });
  console.log('Reassigned project to suhani!');
}
main().finally(() => prisma.$disconnect());
