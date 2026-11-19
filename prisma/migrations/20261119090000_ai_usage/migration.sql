-- Quota du coach : compteur mensuel séparé (supprimer une prise ne rend plus le crédit).
CREATE TABLE "AiUsage" (
    "userId" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "AiUsage_pkey" PRIMARY KEY ("userId","month")
);

ALTER TABLE "AiUsage" ADD CONSTRAINT "AiUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reprise de l'existant : analyses non échouées déjà consommées.
INSERT INTO "AiUsage" ("userId", "month", "count")
SELECT "userId", "month", COUNT(*)::int FROM "Analysis" WHERE "status" <> 'FAILED' GROUP BY "userId", "month";
