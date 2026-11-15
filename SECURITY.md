# Beveiliging

FreeBird bevat financiële gegevens. We nemen beveiligingsproblemen serieus.

## Een kwetsbaarheid melden

Meld kwetsbaarheden **niet** in een openbaar issue. Gebruik in plaats daarvan [GitHub Security Advisories](../../security/advisories/new) van deze repository.

Vermeld:

- wat het probleem is en welke versie of commit;
- hoe je het kunt reproduceren;
- wat de mogelijke impact is.

Je krijgt binnen een week een reactie. Zodra er een oplossing is, maken we die samen met een beschrijving bekend, met vermelding van jou als je dat wilt.

## Je eigen installatie veilig houden

- Draai FreeBird alleen achter HTTPS.
- Gebruik een lang, uniek wachtwoord en bewaar `APP_ENCRYPTION_KEY` in een wachtwoordmanager.
- Houd je server en Docker-images bijgewerkt en haal regelmatig de nieuwste versie van FreeBird op.
- Zet `AGENT_API_TOKEN` alleen aan als je de agent-API echt gebruikt.
- Bewaar back-ups versleuteld en buiten de server.
