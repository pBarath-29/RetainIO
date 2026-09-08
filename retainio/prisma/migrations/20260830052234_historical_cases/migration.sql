-- The AI Advisor's retrieval corpus moves out of mockData.ts and into a table.
--
-- Both advisor tools read these 22 past retention cases: search_historical_cases
-- embeds them and ranks by cosine similarity, search_knowledge_graph matches on
-- shared structure. The retrieval was always real — only the library it drew
-- from was hardcoded, so it could grow only by editing source and redeploying.

CREATE TYPE "CaseOutcome" AS ENUM ('Retained (Renewed +2 Yrs)', 'Retained (Upsold)', 'Churned');

CREATE TABLE "historical_cases" (
    "id" TEXT NOT NULL,
    "case_ref" TEXT NOT NULL,
    "company_name" TEXT NOT NULL,
    "industry" TEXT NOT NULL,
    "initial_risk" INTEGER NOT NULL,
    "primary_issue" TEXT NOT NULL,
    "action_taken" TEXT NOT NULL,
    "outcome" "CaseOutcome" NOT NULL,
    "learnings" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historical_cases_pkey" PRIMARY KEY ("id")
);

-- case_ref keeps the original CASE-01..CASE-22 identifiers stable and unique,
-- so the seed can be re-run without duplicating rows.
CREATE UNIQUE INDEX "historical_cases_case_ref_key" ON "historical_cases"("case_ref");
