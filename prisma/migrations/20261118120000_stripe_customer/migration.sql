ALTER TABLE "User" ADD COLUMN "stripeCustomerId" VARCHAR(64);
CREATE UNIQUE INDEX "User_stripeCustomerId_key" ON "User"("stripeCustomerId");
