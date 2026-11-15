CREATE TYPE "public"."account_type" AS ENUM('asset', 'liability', 'equity', 'revenue', 'expense');--> statement-breakpoint
CREATE TYPE "public"."bank_tx_status" AS ENUM('open', 'booked', 'ignored');--> statement-breakpoint
CREATE TYPE "public"."contact_kind" AS ENUM('business', 'consumer');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'open', 'paid', 'credited', 'uncollectible');--> statement-breakpoint
CREATE TYPE "public"."period_status" AS ENUM('open', 'filed');--> statement-breakpoint
CREATE TYPE "public"."receipt_status" AS ENUM('new', 'parsed', 'booked', 'ignored', 'error');--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"code" varchar(10) NOT NULL,
	"name" text NOT NULL,
	"type" "account_type" NOT NULL,
	"ib_category" text,
	"default_vat_code" varchar(20),
	"system" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "accounts_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "asset_depreciations" (
	"id" serial PRIMARY KEY NOT NULL,
	"asset_id" integer NOT NULL,
	"month" varchar(7) NOT NULL,
	"amount_cents" bigint NOT NULL,
	"journal_entry_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"purchase_date" date NOT NULL,
	"cost_cents" bigint NOT NULL,
	"residual_cents" bigint DEFAULT 0 NOT NULL,
	"months" integer NOT NULL,
	"asset_account_code" varchar(10) DEFAULT '0200' NOT NULL,
	"receipt_id" integer,
	"disposed_at" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_name" text NOT NULL,
	"row_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"bunq_account_id" integer,
	"iban" varchar(34) NOT NULL,
	"name" text NOT NULL,
	"ledger_account_code" varchar(10) DEFAULT '1000' NOT NULL,
	"balance_cents" bigint,
	"balance_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "bank_accounts_bunq_account_id_unique" UNIQUE("bunq_account_id")
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" serial PRIMARY KEY NOT NULL,
	"bank_account_id" integer NOT NULL,
	"bunq_payment_id" bigint,
	"date" date NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"counterparty_name" text,
	"counterparty_iban" varchar(34),
	"description" text DEFAULT '' NOT NULL,
	"type" text,
	"status" "bank_tx_status" DEFAULT 'open' NOT NULL,
	"suggestions" jsonb,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bank_transactions_bunq_payment_id_unique" UNIQUE("bunq_payment_id")
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"kind" "contact_kind" DEFAULT 'business' NOT NULL,
	"is_customer" boolean DEFAULT true NOT NULL,
	"is_supplier" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"contact_person" text,
	"email" text,
	"invoice_email" text,
	"address" text,
	"postcode" text,
	"city" text,
	"country" varchar(2) DEFAULT 'NL' NOT NULL,
	"vat_number" text,
	"kvk" text,
	"vies_valid" boolean,
	"vies_checked_at" timestamp with time zone,
	"vies_name" text,
	"ibans" text[] DEFAULT '{}' NOT NULL,
	"payment_term_days" integer,
	"default_account_code" varchar(10),
	"default_vat_code" varchar(20),
	"notes" text,
	"external_ref" text,
	"archived" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"size" integer NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_params" (
	"id" serial PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "invoice_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"type" varchar(30) NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"meta" jsonb
);
--> statement-breakpoint
CREATE TABLE "invoice_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"invoice_id" integer NOT NULL,
	"position" integer NOT NULL,
	"description" text NOT NULL,
	"quantity" numeric(12, 3) DEFAULT '1' NOT NULL,
	"unit_price_cents" bigint NOT NULL,
	"vat_code" varchar(20) NOT NULL,
	"rate_bp" integer NOT NULL,
	"account_code" varchar(10) NOT NULL,
	"base_cents" bigint NOT NULL,
	"vat_cents" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"number" varchar(30),
	"contact_id" integer NOT NULL,
	"status" "invoice_status" DEFAULT 'draft' NOT NULL,
	"issue_date" date,
	"delivery_date" date,
	"due_date" date,
	"currency" varchar(3) DEFAULT 'EUR' NOT NULL,
	"reference" text,
	"notes" text,
	"snapshot" jsonb,
	"subtotal_cents" bigint DEFAULT 0 NOT NULL,
	"vat_cents" bigint DEFAULT 0 NOT NULL,
	"total_cents" bigint DEFAULT 0 NOT NULL,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"credit_of" integer,
	"journal_entry_id" integer,
	"pdf_file_id" uuid,
	"ubl_file_id" uuid,
	"payment_url" text,
	"bunqme_tab_id" text,
	"recurring_id" integer,
	"sent_at" timestamp with time zone,
	"reminders_sent" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_number_unique" UNIQUE("number")
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"last_message" text
);
--> statement-breakpoint
CREATE TABLE "journal_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"description" text NOT NULL,
	"source_type" varchar(30) NOT NULL,
	"source_id" text,
	"reversal_of" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"account_id" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"contact_id" integer,
	"memo" text
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"key" varchar(30) PRIMARY KEY NOT NULL,
	"next" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "periods" (
	"id" serial PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"quarter" integer NOT NULL,
	"status" "period_status" DEFAULT 'open' NOT NULL,
	"filed_at" timestamp with time zone,
	"closing_entry_id" integer,
	"totals" jsonb
);
--> statement-breakpoint
CREATE TABLE "receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" varchar(10) NOT NULL,
	"message_id" text,
	"source_key" text,
	"from_address" text,
	"subject" text,
	"file_id" uuid,
	"status" "receipt_status" DEFAULT 'new' NOT NULL,
	"parsed" jsonb,
	"error" text,
	"supplier_contact_id" integer,
	"date" date,
	"invoice_number" text,
	"total_cents" bigint,
	"journal_entry_id" integer,
	"paid_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "receipts_source_key_unique" UNIQUE("source_key")
);
--> statement-breakpoint
CREATE TABLE "reconciliations" (
	"id" serial PRIMARY KEY NOT NULL,
	"bank_transaction_id" integer NOT NULL,
	"target_type" varchar(20) NOT NULL,
	"target_id" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"journal_entry_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recurring_invoices" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_id" integer NOT NULL,
	"description" text NOT NULL,
	"lines" jsonb NOT NULL,
	"interval_months" integer DEFAULT 1 NOT NULL,
	"next_date" date NOT NULL,
	"auto_send" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"match" jsonb NOT NULL,
	"action" jsonb NOT NULL,
	"auto_apply" boolean DEFAULT false NOT NULL,
	"hits" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "time_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date NOT NULL,
	"minutes" integer NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vat_codes" (
	"code" varchar(20) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"direction" varchar(10) NOT NULL,
	"rate_bp" integer,
	"kind" varchar(20) NOT NULL,
	"rubriek" varchar(5),
	"invoice_note" text,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vat_entries" (
	"id" serial PRIMARY KEY NOT NULL,
	"entry_id" integer NOT NULL,
	"date" date NOT NULL,
	"vat_code" varchar(20) NOT NULL,
	"rate_bp" integer NOT NULL,
	"base_cents" bigint NOT NULL,
	"vat_cents" bigint NOT NULL,
	"country" varchar(2) NOT NULL,
	"customer_kind" "contact_kind",
	"contact_id" integer,
	"vat_number" text,
	"country_evidence" jsonb
);
--> statement-breakpoint
ALTER TABLE "asset_depreciations" ADD CONSTRAINT "asset_depreciations_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_events" ADD CONSTRAINT "invoice_events_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_vat_code_vat_codes_code_fk" FOREIGN KEY ("vat_code") REFERENCES "public"."vat_codes"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_supplier_contact_id_contacts_id_fk" FOREIGN KEY ("supplier_contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD CONSTRAINT "reconciliations_bank_transaction_id_bank_transactions_id_fk" FOREIGN KEY ("bank_transaction_id") REFERENCES "public"."bank_transactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurring_invoices" ADD CONSTRAINT "recurring_invoices_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_entries" ADD CONSTRAINT "vat_entries_entry_id_journal_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."journal_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_entries" ADD CONSTRAINT "vat_entries_vat_code_vat_codes_code_fk" FOREIGN KEY ("vat_code") REFERENCES "public"."vat_codes"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vat_entries" ADD CONSTRAINT "vat_entries_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_dep_month" ON "asset_depreciations" USING btree ("asset_id","month");--> statement-breakpoint
CREATE INDEX "bank_tx_date" ON "bank_transactions" USING btree ("date");--> statement-breakpoint
CREATE INDEX "bank_tx_status" ON "bank_transactions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "contacts_name" ON "contacts" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_params_year_key" ON "fiscal_params" USING btree ("year","key");--> statement-breakpoint
CREATE INDEX "invoices_status" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "journal_entries_date" ON "journal_entries" USING btree ("date");--> statement-breakpoint
CREATE INDEX "journal_entries_source" ON "journal_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "journal_lines_entry" ON "journal_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "journal_lines_account" ON "journal_lines" USING btree ("account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "periods_yq" ON "periods" USING btree ("year","quarter");--> statement-breakpoint
CREATE INDEX "vat_entries_date" ON "vat_entries" USING btree ("date");