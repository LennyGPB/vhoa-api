-- File d'attente des défis de la semaine (ordre choisi par l'admin).
CREATE TABLE "ThemeQueueItem" (
    "id" UUID NOT NULL,
    "subject" VARCHAR(140) NOT NULL,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ThemeQueueItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ThemeQueueItem_position_idx" ON "ThemeQueueItem"("position");
