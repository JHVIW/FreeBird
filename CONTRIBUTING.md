# Bijdragen aan FreeBird

Fijn dat je wilt helpen. FreeBird is gemaakt door en voor ondernemers, en elke verbetering helpt iedereen die liever onderneemt dan administreert.

## Waar je mee kunt helpen

- **Bugs melden.** Open een issue met wat je deed, wat je verwachtte en wat er gebeurde. Laat persoonlijke of financiële gegevens weg.
- **Bankkoppelingen.** Import van CSV/CAMT.053 voor andere banken dan bunq staat bovenaan de wensenlijst.
- **Fiscale regels.** Klopt een BTW-situatie niet, of is er een nieuwe regel? Verwijs in je issue of PR naar de bron (Belastingdienst, wetstekst).
- **Vertalingen en teksten.** De app is Nederlandstalig; facturen kunnen ook in het Engels.

## Ontwikkelen

```bash
npm ci
cp .env.example .env.local      # DATABASE_URL naar je lokale Postgres
npm run db:migrate
npm run db:demo                 # voorbeelddata op een lege database
npm run dev
```

Tests draaien tegen een echte Postgres-database:

```bash
createdb freebird_test
TEST_DATABASE_URL=postgres://localhost/freebird_test npm test
npm run typecheck
```

## Spelregels voor de boekhoudkern

Deze regels houden de administratie betrouwbaar. Een PR die ze breekt, wordt niet samengevoegd.

1. **Bedragen in centen**, altijd als integer. Nooit floats voor geld.
2. **Elke journaalpost komt op nul uit.** Gebruik `postEntry` uit `src/lib/ledger.ts`.
3. **Definitief is definitief.** Een definitieve factuur of geboekte post wordt nooit gewijzigd of verwijderd. Correcties gaan via een tegenboeking of creditnota.
4. **Vergrendelde periodes blijven dicht.** Niets mag boeken in een ingediend BTW-kwartaal.
5. **Nieuwe fiscale logica krijgt een test** in `tests/`, met een concreet voorbeeld en de verwachte rubrieken.

## Pull requests

- Houd een PR klein en gericht op één ding.
- Beschrijf wat er verandert en waarom. Screenshots helpen bij UI-wijzigingen.
- Draai `npm run typecheck` en `npm test` voordat je de PR opent; CI doet het ook.
- Schemawijziging? Voeg de gegenereerde migratie (`npm run db:generate`) toe aan je PR.

Door bij te dragen ga je ermee akkoord dat je bijdrage onder de [AGPL-3.0-licentie](LICENSE) valt.
