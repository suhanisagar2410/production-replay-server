import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
async function main() {
  const users = await p.user.findMany({ include: { projects: true } });
  console.log("Users:", JSON.stringify(users, null, 2));
  
  const replays = await p.replay.count();
  console.log("Total Replays:", replays);

  const projects = await p.project.findMany();
  console.log("Projects:", JSON.stringify(projects, null, 2));
}
main().finally(() => p.$disconnect());
