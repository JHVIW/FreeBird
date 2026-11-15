import type { Metadata } from "next";
import { Bricolage_Grotesque, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

const display = Bricolage_Grotesque({ subsets: ["latin"], weight: ["500", "600", "700"], variable: "--font-display-face", display: "swap" });
const body = Schibsted_Grotesk({ subsets: ["latin"], variable: "--font-body", display: "swap" });

export const metadata: Metadata = { title: { default: "FreeBird", template: "%s · FreeBird" }, robots: { index: false } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="nl" className={`${display.variable} ${body.variable}`}>
      <body>{children}</body>
    </html>
  );
}
