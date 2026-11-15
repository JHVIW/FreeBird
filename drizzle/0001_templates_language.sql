CREATE TABLE "email_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"kind" varchar(20) NOT NULL,
	"language" varchar(2) NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_layouts" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"style" varchar(20) DEFAULT 'klassiek' NOT NULL,
	"accent_color" varchar(7) DEFAULT '#1E6B47' NOT NULL,
	"font" varchar(20) DEFAULT 'Helvetica' NOT NULL,
	"logo_file_id" uuid,
	"show_payment_box" boolean DEFAULT true NOT NULL,
	"footer_nl" text,
	"footer_en" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"language" varchar(2),
	"lines" jsonb NOT NULL,
	"reference" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "language" varchar(2);--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "layout_id" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "language" varchar(2) DEFAULT 'nl' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "layout_id" integer;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD COLUMN "layout_id" integer;--> statement-breakpoint
ALTER TABLE "vat_codes" ADD COLUMN "invoice_note_en" text;