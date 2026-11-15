import {
  pgTable, pgEnum, serial, integer, bigint, text, varchar, boolean, date, timestamp, jsonb, uniqueIndex, index, numeric, uuid,
} from "drizzle-orm/pg-core";

const cents = (name: string) => bigint(name, { mode: "number" });
const created = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const accountType = pgEnum("account_type", ["asset", "liability", "equity", "revenue", "expense"]);
export const contactKind = pgEnum("contact_kind", ["business", "consumer"]);
export const invoiceStatus = pgEnum("invoice_status", ["draft", "open", "paid", "credited", "uncollectible"]);
export const receiptStatus = pgEnum("receipt_status", ["new", "parsed", "booked", "ignored", "error"]);
export const bankTxStatus = pgEnum("bank_tx_status", ["open", "booked", "ignored"]);
export const periodStatus = pgEnum("period_status", ["open", "filed"]);

/** Grootboekrekeningen (RGS-light). */
export const accounts = pgTable("accounts", {
  id: serial("id").primaryKey(),
  code: varchar("code", { length: 10 }).notNull().unique(),
  name: text("name").notNull(),
  type: accountType("type").notNull(),
  /** Categorie in de IB-aangifte (winst uit onderneming). */
  ibCategory: text("ib_category"),
  /** Standaard BTW-code bij boeken op deze rekening. */
  defaultVatCode: varchar("default_vat_code", { length: 20 }),
  system: boolean("system").notNull().default(false),
  active: boolean("active").notNull().default(true),
});

/** BTW-codes met de rubriek in de aangifte. */
export const vatCodes = pgTable("vat_codes", {
  code: varchar("code", { length: 20 }).primaryKey(),
  name: text("name").notNull(),
  direction: varchar("direction", { length: 10 }).notNull(), // sale | purchase
  /** Percentage in basispunten (2100 = 21%). Null = tarief land klant (OSS). */
  rateBp: integer("rate_bp"),
  kind: varchar("kind", { length: 20 }).notNull(), // standard | zero | reverse_nl | icp_services | icp_goods | export | nonEu_services | oss | rc_eu | rc_nonEu | rc_nl | none
  rubriek: varchar("rubriek", { length: 5 }),
  invoiceNote: text("invoice_note"),
  invoiceNoteEn: text("invoice_note_en"),
  active: boolean("active").notNull().default(true),
});

/** Fiscale parameters per jaar, bijv. EU-tarieven, OSS-drempel, aftrekposten. */
export const fiscalParams = pgTable("fiscal_params", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  note: text("note"),
}, (t) => [uniqueIndex("fiscal_params_year_key").on(t.year, t.key)]);

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  path: text("path").notNull(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  size: integer("size").notNull(),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  createdAt: created(),
});

export const contacts = pgTable("contacts", {
  id: serial("id").primaryKey(),
  kind: contactKind("kind").notNull().default("business"),
  isCustomer: boolean("is_customer").notNull().default(true),
  isSupplier: boolean("is_supplier").notNull().default(false),
  name: text("name").notNull(),
  contactPerson: text("contact_person"),
  email: text("email"),
  invoiceEmail: text("invoice_email"),
  address: text("address"),
  postcode: text("postcode"),
  city: text("city"),
  country: varchar("country", { length: 2 }).notNull().default("NL"),
  vatNumber: text("vat_number"),
  kvk: text("kvk"),
  viesValid: boolean("vies_valid"),
  viesCheckedAt: timestamp("vies_checked_at", { withTimezone: true }),
  viesName: text("vies_name"),
  ibans: text("ibans").array().notNull().default([]),
  paymentTermDays: integer("payment_term_days"),
  defaultAccountCode: varchar("default_account_code", { length: 10 }),
  defaultVatCode: varchar("default_vat_code", { length: 20 }),
  /** nl | en; null = automatisch (NL → nl, anders en). */
  language: varchar("language", { length: 2 }),
  layoutId: integer("layout_id"),
  notes: text("notes"),
  externalRef: text("external_ref"),
  archived: boolean("archived").notNull().default(false),
  createdAt: created(),
}, (t) => [index("contacts_name").on(t.name)]);

export const journalEntries = pgTable("journal_entries", {
  id: serial("id").primaryKey(),
  date: date("date", { mode: "string" }).notNull(),
  description: text("description").notNull(),
  sourceType: varchar("source_type", { length: 30 }).notNull(), // invoice | bank | receipt | memorial | vat_close | depreciation | opening | sale
  sourceId: text("source_id"),
  reversalOf: integer("reversal_of"),
  createdAt: created(),
}, (t) => [index("journal_entries_date").on(t.date), index("journal_entries_source").on(t.sourceType, t.sourceId)]);

/** amountCents: debet positief, credit negatief. Som per entry = 0. */
export const journalLines = pgTable("journal_lines", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").notNull().references(() => journalEntries.id, { onDelete: "cascade" }),
  accountId: integer("account_id").notNull().references(() => accounts.id),
  amountCents: cents("amount_cents").notNull(),
  contactId: integer("contact_id").references(() => contacts.id),
  memo: text("memo"),
}, (t) => [index("journal_lines_entry").on(t.entryId), index("journal_lines_account").on(t.accountId)]);

/** BTW-administratie: één regel per BTW-code per boeking. Bron voor aangifte, ICP en OSS. */
export const vatEntries = pgTable("vat_entries", {
  id: serial("id").primaryKey(),
  entryId: integer("entry_id").notNull().references(() => journalEntries.id, { onDelete: "cascade" }),
  date: date("date", { mode: "string" }).notNull(),
  vatCode: varchar("vat_code", { length: 20 }).notNull().references(() => vatCodes.code),
  rateBp: integer("rate_bp").notNull(),
  baseCents: cents("base_cents").notNull(),
  vatCents: cents("vat_cents").notNull(),
  country: varchar("country", { length: 2 }).notNull(),
  customerKind: contactKind("customer_kind"),
  contactId: integer("contact_id").references(() => contacts.id),
  vatNumber: text("vat_number"),
  /** Bewijs land klant (OSS): bijv. {"iban":"DE","address":"DE"}. */
  countryEvidence: jsonb("country_evidence"),
}, (t) => [index("vat_entries_date").on(t.date)]);

export const invoices = pgTable("invoices", {
  id: serial("id").primaryKey(),
  number: varchar("number", { length: 30 }).unique(),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  status: invoiceStatus("status").notNull().default("draft"),
  issueDate: date("issue_date", { mode: "string" }),
  deliveryDate: date("delivery_date", { mode: "string" }),
  dueDate: date("due_date", { mode: "string" }),
  currency: varchar("currency", { length: 3 }).notNull().default("EUR"),
  language: varchar("language", { length: 2 }).notNull().default("nl"),
  layoutId: integer("layout_id"),
  reference: text("reference"),
  notes: text("notes"),
  /** Snapshot van klant + bedrijf op moment van definitief maken. */
  snapshot: jsonb("snapshot"),
  subtotalCents: cents("subtotal_cents").notNull().default(0),
  vatCents: cents("vat_cents").notNull().default(0),
  totalCents: cents("total_cents").notNull().default(0),
  paidCents: cents("paid_cents").notNull().default(0),
  creditOf: integer("credit_of"),
  journalEntryId: integer("journal_entry_id"),
  pdfFileId: uuid("pdf_file_id"),
  ublFileId: uuid("ubl_file_id"),
  paymentUrl: text("payment_url"),
  bunqmeTabId: text("bunqme_tab_id"),
  recurringId: integer("recurring_id"),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  remindersSent: integer("reminders_sent").notNull().default(0),
  createdAt: created(),
}, (t) => [index("invoices_status").on(t.status)]);

export const invoiceLines = pgTable("invoice_lines", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  description: text("description").notNull(),
  quantity: numeric("quantity", { precision: 12, scale: 3 }).notNull().default("1"),
  unitPriceCents: cents("unit_price_cents").notNull(),
  vatCode: varchar("vat_code", { length: 20 }).notNull().references(() => vatCodes.code),
  rateBp: integer("rate_bp").notNull(),
  accountCode: varchar("account_code", { length: 10 }).notNull(),
  baseCents: cents("base_cents").notNull(),
  vatCents: cents("vat_cents").notNull(),
});

export const invoiceEvents = pgTable("invoice_events", {
  id: serial("id").primaryKey(),
  invoiceId: integer("invoice_id").notNull().references(() => invoices.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 30 }).notNull(), // finalized | sent | reminder | paid | bounced | credited | payment
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  meta: jsonb("meta"),
});

export const recurringInvoices = pgTable("recurring_invoices", {
  id: serial("id").primaryKey(),
  contactId: integer("contact_id").notNull().references(() => contacts.id),
  description: text("description").notNull(),
  lines: jsonb("lines").notNull(), // [{description, quantity, unitPriceCents, vatCode, accountCode}]
  layoutId: integer("layout_id"),
  intervalMonths: integer("interval_months").notNull().default(1),
  nextDate: date("next_date", { mode: "string" }).notNull(),
  autoSend: boolean("auto_send").notNull().default(false),
  active: boolean("active").notNull().default(true),
  createdAt: created(),
});

export const numberSequences = pgTable("number_sequences", {
  key: varchar("key", { length: 30 }).primaryKey(),
  next: integer("next").notNull(),
});

export const bankAccounts = pgTable("bank_accounts", {
  id: serial("id").primaryKey(),
  bunqAccountId: integer("bunq_account_id").unique(),
  iban: varchar("iban", { length: 34 }).notNull(),
  name: text("name").notNull(),
  ledgerAccountCode: varchar("ledger_account_code", { length: 10 }).notNull().default("1000"),
  balanceCents: cents("balance_cents"),
  balanceAt: timestamp("balance_at", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
});

export const bankTransactions = pgTable("bank_transactions", {
  id: serial("id").primaryKey(),
  bankAccountId: integer("bank_account_id").notNull().references(() => bankAccounts.id),
  bunqPaymentId: bigint("bunq_payment_id", { mode: "number" }).unique(),
  date: date("date", { mode: "string" }).notNull(),
  amountCents: cents("amount_cents").notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("EUR"),
  counterpartyName: text("counterparty_name"),
  counterpartyIban: varchar("counterparty_iban", { length: 34 }),
  description: text("description").notNull().default(""),
  type: text("type"),
  status: bankTxStatus("status").notNull().default("open"),
  /** Gecachte voorstellen van de matching-engine. */
  suggestions: jsonb("suggestions"),
  /** Boekvoorstel van de AI: {accountCode, vatCode, contactId, confidence, reason, model, at}. */
  aiSuggestion: jsonb("ai_suggestion"),
  /** Bon of factuur als bewijs bij een directe boeking (zonder inkoopboeking). */
  evidenceFileId: uuid("evidence_file_id").references(() => files.id),
  raw: jsonb("raw"),
  createdAt: created(),
}, (t) => [index("bank_tx_date").on(t.date), index("bank_tx_status").on(t.status)]);

/** Koppeling banktransactie ↔ factuur/bon/journaalpost. */
export const reconciliations = pgTable("reconciliations", {
  id: serial("id").primaryKey(),
  bankTransactionId: integer("bank_transaction_id").notNull().references(() => bankTransactions.id, { onDelete: "cascade" }),
  targetType: varchar("target_type", { length: 20 }).notNull(), // invoice | receipt | entry
  targetId: integer("target_id").notNull(),
  amountCents: cents("amount_cents").notNull(),
  journalEntryId: integer("journal_entry_id"),
  createdAt: created(),
});

export const rules = pgTable("rules", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** {counterpartyContains?, descriptionContains?, iban?, direction?: "in"|"out"} */
  match: jsonb("match").notNull(),
  /** {kind:"book", accountCode, vatCode, contactId?} | {kind:"sale", accountCode} | {kind:"ignore"} */
  action: jsonb("action").notNull(),
  autoApply: boolean("auto_apply").notNull().default(false),
  hits: integer("hits").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: created(),
});

export const receipts = pgTable("receipts", {
  id: serial("id").primaryKey(),
  source: varchar("source", { length: 10 }).notNull(), // mail | upload
  messageId: text("message_id"),
  /** messageId#bijlage-index, voorkomt dubbele import. */
  sourceKey: text("source_key").unique(),
  fromAddress: text("from_address"),
  subject: text("subject"),
  fileId: uuid("file_id").references(() => files.id),
  status: receiptStatus("status").notNull().default("new"),
  parsed: jsonb("parsed"),
  error: text("error"),
  supplierContactId: integer("supplier_contact_id").references(() => contacts.id),
  date: date("date", { mode: "string" }),
  invoiceNumber: text("invoice_number"),
  totalCents: cents("total_cents"),
  journalEntryId: integer("journal_entry_id"),
  paidCents: cents("paid_cents").notNull().default(0),
  /** Wat de inbox er automatisch mee deed, bijv. "Automatisch geboekt" of "Gekoppeld als bewijs bij ...". */
  autoNote: text("auto_note"),
  receivedAt: created(),
});

export const assets = pgTable("assets", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  purchaseDate: date("purchase_date", { mode: "string" }).notNull(),
  costCents: cents("cost_cents").notNull(),
  residualCents: cents("residual_cents").notNull().default(0),
  months: integer("months").notNull(),
  assetAccountCode: varchar("asset_account_code", { length: 10 }).notNull().default("0200"),
  receiptId: integer("receipt_id"),
  disposedAt: date("disposed_at", { mode: "string" }),
  createdAt: created(),
});

export const assetDepreciations = pgTable("asset_depreciations", {
  id: serial("id").primaryKey(),
  assetId: integer("asset_id").notNull().references(() => assets.id, { onDelete: "cascade" }),
  month: varchar("month", { length: 7 }).notNull(), // YYYY-MM
  amountCents: cents("amount_cents").notNull(),
  journalEntryId: integer("journal_entry_id").notNull(),
}, (t) => [uniqueIndex("asset_dep_month").on(t.assetId, t.month)]);

export const timeEntries = pgTable("time_entries", {
  id: serial("id").primaryKey(),
  date: date("date", { mode: "string" }).notNull(),
  minutes: integer("minutes").notNull(),
  note: text("note"),
  createdAt: created(),
});

export const periods = pgTable("periods", {
  id: serial("id").primaryKey(),
  year: integer("year").notNull(),
  quarter: integer("quarter").notNull(),
  status: periodStatus("status").notNull().default("open"),
  filedAt: timestamp("filed_at", { withTimezone: true }),
  closingEntryId: integer("closing_entry_id"),
  totals: jsonb("totals"),
}, (t) => [uniqueIndex("periods_yq").on(t.year, t.quarter)]);

export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  tableName: text("table_name").notNull(),
  rowId: text("row_id").notNull(),
  action: text("action").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const jobRuns = pgTable("job_runs", {
  name: text("name").primaryKey(),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastStatus: text("last_status"),
  lastMessage: text("last_message"),
});

/** Opmaak van de factuur-PDF. */
export const invoiceLayouts = pgTable("invoice_layouts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  style: varchar("style", { length: 20 }).notNull().default("klassiek"), // klassiek | modern | compact
  accentColor: varchar("accent_color", { length: 7 }).notNull().default("#1E6B47"),
  font: varchar("font", { length: 20 }).notNull().default("Helvetica"), // Helvetica | Times-Roman | Courier
  logoFileId: uuid("logo_file_id"),
  showPaymentBox: boolean("show_payment_box").notNull().default(true),
  footerNl: text("footer_nl"),
  footerEn: text("footer_en"),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: created(),
});

/** Opgeslagen factuurinhoud: regels, referentie en opmerking. */
export const invoiceTemplates = pgTable("invoice_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  language: varchar("language", { length: 2 }),
  lines: jsonb("lines").notNull(), // [{description, quantity, unitPriceCents, vatCode?, accountCode?}]
  reference: text("reference"),
  notes: text("notes"),
  createdAt: created(),
});

/** Mailteksten voor factuur en herinnering, per taal. */
export const emailTemplates = pgTable("email_templates", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  kind: varchar("kind", { length: 20 }).notNull(), // invoice | reminder | credit
  language: varchar("language", { length: 2 }).notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: created(),
});

/** Uitkomsten van AI-taken die we bewaren, zoals de BTW-controle per kwartaal en gestelde vragen. */
export const aiResults = pgTable("ai_results", {
  id: serial("id").primaryKey(),
  kind: varchar("kind", { length: 30 }).notNull(), // vat_review | question
  key: text("key"),
  input: text("input"),
  value: jsonb("value").notNull(),
  createdAt: created(),
}, (t) => [index("ai_results_kind_key").on(t.kind, t.key)]);

/**
 * Alles wat uit Moneybird is opgehaald: archief (bewaarplicht) en bron voor de overname.
 * Eén rij per Moneybird-object, met de ruwe JSON en de opgeslagen bestanden.
 */
export const mbItems = pgTable("mb_items", {
  id: serial("id").primaryKey(),
  kind: varchar("kind", { length: 40 }).notNull(), // sales_invoice | external_sales_invoice | purchase_invoice | receipt | general_journal_document | general_document | typeless_document | ledger_account | tax_rate | financial_account | report
  mbId: text("mb_id").notNull(),
  version: integer("version"),
  date: date("date", { mode: "string" }),
  number: text("number"),
  contactMbId: text("contact_mb_id"),
  contactName: text("contact_name"),
  totalCents: cents("total_cents"),
  state: text("state"),
  raw: jsonb("raw").notNull(),
  /** [{kind: "pdf"|"attachment", attachmentId?, name, fileId?, error?}] */
  files: jsonb("files").notNull().default([]),
  /** Wat de overname ermee deed: "invoice:12", "receipt:5", "evidence:88", "entry:301", "skipped". */
  importedAs: text("imported_as"),
  importNote: text("import_note"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("mb_items_kind_id").on(t.kind, t.mbId), index("mb_items_kind_date").on(t.kind, t.date)]);
