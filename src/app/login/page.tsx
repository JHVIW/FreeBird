import { login } from "../actions/auth";
import { Flash } from "@/components/ui";
import { Logo, Wordmark } from "@/components/logo";
import type { SP } from "@/lib/sp";
import { str } from "@/lib/sp";

export const metadata = { title: "Inloggen" };

export default async function LoginPage({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  return (
    <main className="login">
      <section className="sky" aria-label="Over FreeBird">
        <Wordmark size={34} />
        <div>
          <h2>Je boekhouding, op je eigen server.</h2>
          <p>Facturen, bank, bonnen en BTW-aangifte in één app. Zonder abonnement, en je data blijft van jou.</p>
        </div>
        <Logo className="flock" size={500} />
      </section>
      <div className="pane">
        <form action={login}>
          <h1>Inloggen</h1>
          <p className="lead">Welkom terug.</p>
          <Flash sp={sp} />
          <input type="hidden" name="next" value={str(sp.next) ?? "/"} />
          <div className="stack">
            <div className="field">
              <label htmlFor="pw">Wachtwoord</label>
              <input id="pw" name="password" type="password" autoComplete="current-password" required autoFocus />
            </div>
            <button className="btn pri" type="submit">Inloggen</button>
          </div>
        </form>
      </div>
    </main>
  );
}
