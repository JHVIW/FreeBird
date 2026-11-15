import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import { getSetting, type MailSettings } from "./settings";

export function smtpConfigured(m: MailSettings) {
  return !!(m.smtpHost && m.smtpUser && m.smtpPass);
}
export function imapConfigured(m: MailSettings) {
  return !!(m.imapHost && m.imapUser && m.imapPass);
}

export function imapClient(m: MailSettings) {
  return new ImapFlow({
    host: m.imapHost, port: m.imapPort, secure: m.imapSecure,
    auth: { user: m.imapUser, pass: m.imapPass! }, logger: false,
  });
}

export type Attachment = { filename: string; content: Buffer; contentType: string };

/** Verstuurt via eigen SMTP en zet een kopie in de map Verzonden via IMAP (als ingesteld). */
export async function sendMail(msg: { to: string; subject: string; text: string; attachments?: Attachment[]; cc?: string }) {
  const m = await getSetting("mail");
  if (!smtpConfigured(m)) throw new Error("SMTP is nog niet ingesteld (Instellingen › E-mail)");
  const transport = nodemailer.createTransport({
    host: m.smtpHost, port: m.smtpPort, secure: m.smtpSecure, auth: { user: m.smtpUser, pass: m.smtpPass },
  });
  const mail = {
    from: { name: m.fromName, address: m.fromAddress }, to: msg.to, cc: msg.cc, subject: msg.subject, text: msg.text,
    attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  };
  const info = await transport.sendMail(mail);

  if (imapConfigured(m) && m.sentFolder) {
    try {
      const raw = await new Promise<Buffer>((resolve, reject) => {
        const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
        builder.sendMail({ ...mail, messageId: info.messageId }, (err, res) => (err ? reject(err) : resolve(res!.message as Buffer)));
      });
      const client = imapClient(m);
      await client.connect();
      await client.append(m.sentFolder, raw, ["\\Seen"]);
      await client.logout();
    } catch (e) {
      console.warn("Kopie naar Verzonden mislukt:", (e as Error).message);
    }
  }
  return { messageId: info.messageId };
}

export async function testSmtp() {
  const m = await getSetting("mail");
  const t = nodemailer.createTransport({ host: m.smtpHost, port: m.smtpPort, secure: m.smtpSecure, auth: { user: m.smtpUser, pass: m.smtpPass } });
  await t.verify();
}

export async function testImap() {
  const m = await getSetting("mail");
  const c = imapClient(m);
  await c.connect();
  const list = await c.list();
  await c.logout();
  return list.map((f) => f.path);
}

export function fillTemplate(tpl: string, vars: Record<string, string>) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}
