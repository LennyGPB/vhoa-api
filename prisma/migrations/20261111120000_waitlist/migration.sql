-- CreateEnum
CREATE TYPE "WaitlistPlatform" AS ENUM ('IOS', 'ANDROID');

-- CreateTable
CREATE TABLE "WaitlistEntry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" VARCHAR(254) NOT NULL,
    "emailKey" VARCHAR(254) NOT NULL,
    "platform" "WaitlistPlatform" NOT NULL,
    "ipHash" VARCHAR(64) NOT NULL,
    "source" VARCHAR(30) NOT NULL DEFAULT 'web',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WaitlistEntry_emailKey_key" ON "WaitlistEntry"("emailKey");

-- CreateIndex
CREATE INDEX "WaitlistEntry_ipHash_createdAt_idx" ON "WaitlistEntry"("ipHash", "createdAt");

