CREATE TABLE "mb_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" varchar(40) NOT NULL,
	"mb_id" text NOT NULL,
	"version" integer,
	"date" date,
	"number" text,
	"contact_mb_id" text,
	"contact_name" text,
	"total_cents" bigint,
	"state" text,
	"raw" jsonb NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imported_as" text,
	"import_note" text,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mb_items_kind_id" ON "mb_items" USING btree ("kind","mb_id");--> statement-breakpoint
CREATE INDEX "mb_items_kind_date" ON "mb_items" USING btree ("kind","date");