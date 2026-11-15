import type { NextConfig } from "next";

const config: NextConfig = {
  serverExternalPackages: ["@react-pdf/renderer", "imapflow", "mailparser", "nodemailer", "postgres", "unpdf"],
  experimental: { serverActions: { bodySizeLimit: "15mb" } },
};

export default config;
