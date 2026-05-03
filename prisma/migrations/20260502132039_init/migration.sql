-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Replay" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "triggerType" TEXT NOT NULL,
    "triggerLabel" TEXT,
    "errorMessage" TEXT,
    "errorStack" TEXT,
    "serviceName" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "capturedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dataUrl" TEXT NOT NULL,
    CONSTRAINT "Replay_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_apiKey_key" ON "Project"("apiKey");
