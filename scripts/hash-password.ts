import bcrypt from "bcryptjs";

const pw = process.argv[2];
if (!pw || pw.length < 12) {
  console.error("Gebruik: npm run hash-password -- 'een-lang-wachtwoord' (minimaal 12 tekens)");
  process.exit(1);
}
const hash = bcrypt.hashSync(pw, 12);
console.log(`ADMIN_PASSWORD_HASH_B64=${Buffer.from(hash).toString("base64")}`);
