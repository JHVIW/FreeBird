import React from "react";
import { Document, Page, Text, View, StyleSheet, renderToBuffer, Link, Image } from "@react-pdf/renderer";
import type { InvoiceSnapshot } from "../invoices";
import { formatIban } from "../eu";
import { t, docDate, docMoney, docPct, docQty, docCountry, type Lang } from "../i18n";

export type PdfLayout = {
  style: "klassiek" | "modern" | "compact" | string;
  accentColor: string;
  font: "Helvetica" | "Times-Roman" | "Courier" | string;
  logo?: { data: Buffer; format: "png" | "jpg" } | null;
  showPaymentBox: boolean;
  footer?: string | null;
};

export const DEFAULT_LAYOUT: PdfLayout = { style: "klassiek", accentColor: "#1E6B47", font: "Helvetica", showPaymentBox: true };

export type PdfInvoice = {
  number: string; issueDate: string; deliveryDate: string | null; dueDate: string; reference: string | null; notes: string | null;
  subtotalCents: number; vatCents: number; totalCents: number; paymentUrl: string | null; isCredit: boolean;
  lines: { description: string; quantity: string; unitPriceCents: number; rateBp: number; baseCents: number; vatCents: number; vatCode: string }[];
  snapshot: InvoiceSnapshot; footer: string; language: Lang; layout?: PdfLayout;
};

const BOLD: Record<string, string> = { Helvetica: "Helvetica-Bold", "Times-Roman": "Times-Bold", Courier: "Courier-Bold" };

function styles(l: PdfLayout) {
  const compact = l.style === "compact";
  const bold = BOLD[l.font] ?? "Helvetica-Bold";
  return {
    bold,
    s: StyleSheet.create({
      page: { paddingTop: l.style === "modern" ? 0 : compact ? 36 : 48, paddingHorizontal: compact ? 36 : 48, paddingBottom: 64, fontSize: compact ? 8.5 : 9.5, fontFamily: l.font, color: "#17191E", lineHeight: 1.45 },
      row: { flexDirection: "row", justifyContent: "space-between" },
      muted: { color: "#5F6168" },
      label: { color: "#5F6168", fontSize: compact ? 7.5 : 8, marginTop: 6 },
      th: { fontFamily: bold, paddingVertical: 5, borderBottomWidth: l.style === "modern" ? 0 : 1.2, borderBottomColor: "#17191E", color: l.style === "modern" ? "#FFFFFF" : "#17191E" },
      td: { paddingVertical: compact ? 4 : 6, borderBottomWidth: 0.5, borderBottomColor: "#DDDDDD" },
      note: { marginTop: 18, padding: 8, backgroundColor: "#F4F3EE" },
      pay: { borderWidth: 1, borderColor: l.accentColor, padding: 8, alignItems: "center" },
    }),
  };
}

function InvoiceDoc({ inv }: { inv: PdfInvoice }) {
  const L = inv.layout ?? DEFAULT_LAYOUT;
  const { s, bold } = styles(L);
  const tr = t(inv.language);
  const lang = inv.language;
  const c = inv.snapshot.company;
  const k = inv.snapshot.contact;
  const title = inv.isCredit ? tr.creditNote : tr.invoice;
  const vatGroups = new Map<number, { base: number; vat: number }>();
  for (const l of inv.lines) {
    const g = vatGroups.get(l.rateBp) ?? { base: 0, vat: 0 };
    g.base += l.baseCents; g.vat += l.vatCents;
    vatGroups.set(l.rateBp, g);
  }
  const modern = L.style === "modern";
  const compact = L.style === "compact";
  const pad = compact ? 36 : 48;
  const logo = L.logo ? <Image src={L.logo} style={{ maxHeight: compact ? 36 : 48, maxWidth: 160, objectFit: "contain", marginBottom: 6 }} /> : null;
  const sender = (color?: string) => (
    <View>
      {logo && !modern ? logo : null}
      <Text style={{ fontSize: compact ? 13 : 15, fontFamily: bold, lineHeight: 1.15, marginBottom: 4, color }}>{c.name}</Text>
      <Text style={{ color: color ?? "#5F6168" }}>{c.address}</Text>
      <Text style={{ color: color ?? "#5F6168" }}>{c.postcode} {c.city}{lang === "en" ? `, ${docCountry(c.country, lang)}` : ""}</Text>
      <Text style={{ color: color ?? "#5F6168" }}>{c.email}{c.phone ? ` · ${c.phone}` : ""}</Text>
      <Text style={{ color: color ?? "#5F6168" }}>{tr.cocShort} {c.kvk} · {tr.vatShort} {c.vatNumber}</Text>
    </View>
  );
  const docTitle = (color?: string) => (
    <View style={{ alignItems: "flex-end" }}>
      {modern && logo ? logo : null}
      <Text style={{ fontSize: 18, fontFamily: bold, lineHeight: 1.15, marginBottom: 4, color: color ?? (L.style === "klassiek" ? "#17191E" : L.accentColor) }}>{title}</Text>
      <Text style={{ color: color ?? "#5F6168" }}>{inv.number}</Text>
    </View>
  );

  return (
    <Document title={`${title} ${inv.number}`} author={c.name} language={lang}>
      <Page size="A4" style={s.page}>
        {modern ? (
          <View style={{ backgroundColor: L.accentColor, marginHorizontal: -pad, paddingHorizontal: pad, paddingTop: 40, paddingBottom: 24, marginBottom: 8 }}>
            <View style={s.row}>{sender("#FFFFFF")}{docTitle("#FFFFFF")}</View>
          </View>
        ) : (
          <View style={[s.row, L.style === "klassiek" ? {} : { borderBottomWidth: 2, borderBottomColor: L.accentColor, paddingBottom: 10 }]}>{sender()}{docTitle()}</View>
        )}

        <View style={[s.row, { marginTop: compact ? 18 : 28 }]}>
          <View style={{ width: "55%" }}>
            <Text style={s.label}>{tr.to}</Text>
            <Text style={{ fontFamily: bold }}>{k.name}</Text>
            {k.contactPerson ? <Text>{tr.attn} {k.contactPerson}</Text> : null}
            {k.address ? <Text>{k.address}</Text> : null}
            {(k.postcode || k.city) ? <Text>{[k.postcode, k.city].filter(Boolean).join(" ")}</Text> : null}
            {k.country !== c.country || lang === "en" ? <Text>{docCountry(k.country, lang)}</Text> : null}
            {k.vatNumber ? <Text>{tr.vatNumber} {k.vatNumber}</Text> : null}
          </View>
          <View style={{ width: "40%" }}>
            <Text style={s.label}>{tr.invoiceDate}</Text><Text>{docDate(inv.issueDate, lang)}</Text>
            {inv.deliveryDate ? <><Text style={s.label}>{tr.deliveryDate}</Text><Text>{docDate(inv.deliveryDate, lang)}</Text></> : null}
            {!inv.isCredit ? <><Text style={s.label}>{tr.dueDate}</Text><Text>{docDate(inv.dueDate, lang)}</Text></> : null}
            {inv.reference ? <><Text style={s.label}>{tr.reference}</Text><Text>{inv.reference}</Text></> : null}
            {inv.snapshot.creditOfNumber ? <><Text style={s.label}>{tr.creditOf}</Text><Text>{tr.invoiceWord} {inv.snapshot.creditOfNumber}</Text></> : null}
          </View>
        </View>

        <View style={{ marginTop: compact ? 18 : 28 }}>
          <View style={[{ flexDirection: "row" }, modern ? { backgroundColor: L.accentColor, paddingHorizontal: 6 } : {}]}>
            <Text style={[s.th, { width: "52%" }]}>{tr.description}</Text>
            <Text style={[s.th, { width: "10%", textAlign: "right" }]}>{tr.qty}</Text>
            <Text style={[s.th, { width: "14%", textAlign: "right" }]}>{tr.price}</Text>
            <Text style={[s.th, { width: "8%", textAlign: "right" }]}>{tr.vat}</Text>
            <Text style={[s.th, { width: "16%", textAlign: "right" }]}>{tr.total}</Text>
          </View>
          {inv.lines.map((l, i) => (
            <View key={i} style={[{ flexDirection: "row" }, modern ? { paddingHorizontal: 6 } : {}]} wrap={false}>
              <Text style={[s.td, { width: "52%", paddingRight: 8 }]}>{l.description}</Text>
              <Text style={[s.td, { width: "10%", textAlign: "right" }]}>{docQty(l.quantity, lang)}</Text>
              <Text style={[s.td, { width: "14%", textAlign: "right" }]}>{docMoney(l.unitPriceCents, lang)}</Text>
              <Text style={[s.td, { width: "8%", textAlign: "right" }]}>{docPct(l.rateBp, lang)}</Text>
              <Text style={[s.td, { width: "16%", textAlign: "right" }]}>{docMoney(l.baseCents, lang)}</Text>
            </View>
          ))}
        </View>

        <View style={{ flexDirection: "row", justifyContent: "flex-end", marginTop: 12 }} wrap={false}>
          <View style={{ width: 230 }}>
            <View style={s.row}><Text>{tr.subtotal}</Text><Text>{docMoney(inv.subtotalCents, lang)}</Text></View>
            {[...vatGroups.entries()].filter(([rate]) => rate > 0).map(([rate, g]) => (
              <View key={rate} style={s.row}><Text>{tr.vatOver(docPct(rate, lang), docMoney(g.base, lang))}</Text><Text>{docMoney(g.vat, lang)}</Text></View>
            ))}
            <View style={[s.row, { marginTop: 4, paddingTop: 4, borderTopWidth: 1, borderTopColor: L.style === "klassiek" ? "#17191E" : L.accentColor }]}>
              <Text style={{ fontFamily: bold }}>{tr.total}</Text>
              <Text style={{ fontFamily: bold, color: L.style === "klassiek" ? "#17191E" : L.accentColor }}>{docMoney(inv.totalCents, lang)}</Text>
            </View>
          </View>
        </View>

        {inv.snapshot.notes.map((n, i) => <Text key={i} style={s.note}>{n}</Text>)}
        {inv.notes ? <Text style={{ marginTop: 12 }}>{inv.notes}</Text> : null}

        {!inv.isCredit && inv.totalCents > 0 ? (
          <View style={[s.row, { marginTop: 22, alignItems: "flex-end" }]} wrap={false}>
            <View>
              <Text>{tr.payBefore(docDate(inv.dueDate, lang))}</Text>
              <Text style={{ fontFamily: bold }}>{tr.payTo(formatIban(c.iban), c.name)}</Text>
              {lang === "en" && c.bic ? <Text>BIC {c.bic}</Text> : null}
              <Text>{tr.payRef(inv.number)}</Text>
            </View>
            {inv.paymentUrl && L.showPaymentBox ? (
              <View style={s.pay}>
                <Text style={{ fontFamily: bold, color: L.accentColor }}>{tr.payNow}</Text>
                <Link src={inv.paymentUrl}>{inv.paymentUrl.replace(/^https?:\/\//, "")}</Link>
              </View>
            ) : null}
          </View>
        ) : null}

        <Text style={{ position: "absolute", bottom: 32, left: pad, right: pad, fontSize: 8, color: "#5F6168", textAlign: "center" }} fixed>
          {L.footer || inv.footer || `${c.name} · ${tr.cocShort} ${c.kvk} · ${tr.vatShort} ${c.vatNumber} · ${formatIban(c.iban)}`}
        </Text>
      </Page>
    </Document>
  );
}

export async function renderInvoicePdf(inv: PdfInvoice): Promise<Buffer> {
  return renderToBuffer(<InvoiceDoc inv={inv} />);
}
