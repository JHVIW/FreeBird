-- Alleen-lezen-rol voor "Vragen aan je boekhouding". De app schakelt per vraag naar deze rol
-- (SET LOCAL ROLE) in een read-only transactie. Geen toegang tot instellingen, bestanden,
-- e-mailadressen, IBAN's of de ruwe bankdata. Zonder rechten om rollen te maken wordt dit
-- overgeslagen; de vragenpagina meldt dat dan.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'freebird_ai') THEN
    CREATE ROLE freebird_ai NOLOGIN;
  END IF;
  EXECUTE format('GRANT freebird_ai TO %I', current_user);
  GRANT USAGE ON SCHEMA public TO freebird_ai;
  GRANT SELECT ON accounts, vat_codes, journal_entries, journal_lines, vat_entries, invoice_lines, reconciliations,
    assets, asset_depreciations, time_entries, fiscal_params TO freebird_ai;
  GRANT SELECT (id, kind, is_customer, is_supplier, name, country, vat_number, payment_term_days, archived, created_at) ON contacts TO freebird_ai;
  GRANT SELECT (id, number, contact_id, status, issue_date, delivery_date, due_date, currency, language, reference,
    subtotal_cents, vat_cents, total_cents, paid_cents, credit_of, sent_at, reminders_sent, created_at) ON invoices TO freebird_ai;
  GRANT SELECT (id, invoice_id, type, at) ON invoice_events TO freebird_ai;
  GRANT SELECT (id, bank_account_id, date, amount_cents, currency, counterparty_name, description, type, status, created_at) ON bank_transactions TO freebird_ai;
  GRANT SELECT (id, name, ledger_account_code, balance_cents, balance_at) ON bank_accounts TO freebird_ai;
  GRANT SELECT (id, source, status, supplier_contact_id, date, invoice_number, total_cents, paid_cents, created_at) ON receipts TO freebird_ai;
  GRANT SELECT (id, year, quarter, status, filed_at) ON periods TO freebird_ai;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'freebird_ai niet aangemaakt: onvoldoende rechten';
END
$$;
