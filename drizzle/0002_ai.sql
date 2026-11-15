CREATE TABLE "ai_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(30) NOT NULL,
	"key" text,
	"input" text,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "ai_suggestion" jsonb;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "evidence_file_id" uuid;--> statement-breakpoint
CREATE INDEX "ai_results_kind_key" ON "ai_results" USING btree ("kind","key");--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_evidence_file_id_files_id_fk" FOREIGN KEY ("evidence_file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;