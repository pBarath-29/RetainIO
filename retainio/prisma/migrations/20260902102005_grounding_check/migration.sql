-- AlterTable
ALTER TABLE "conversation_messages" ADD COLUMN     "ungrounded_figures" TEXT[] DEFAULT ARRAY[]::TEXT[];
