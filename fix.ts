import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  await p.project.updateMany({
    data: { userId: 'de7c9bd5-e8d0-415d-86ac-ddf0b11bafa1' }
  });
  console.log("Updated projects to belong to the correct user.");
}
main().finally(() => p.$disconnect());
