-- CreateTable
CREATE TABLE "CronLock" (
    "name" VARCHAR(40) NOT NULL,
    "lockedUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CronLock_pkey" PRIMARY KEY ("name")
);
