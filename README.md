# Cranioklinikken · romkalender

`preview/` er den klikkbare prototypen med eksempeldata. Netlify-oppsettet
bygger `public/` og Netlify Functions fra `netlify/functions/`.

Dette arbeidet innfører e-postkode og en innlogget ukevisning av egendefinerte
Wix-arbeidstider. Det er et utviklingstrinn før romreservasjoner og Wix-synk
kan tas i bruk. Ukevisningen viser individuelt registrerte arbeidstider fra
Wix. Den utleder ingen romfordeling fra arbeidstidene. Wix er fasit. Administrator
ser overlapp, ugyldige intervaller og ukjente timeplaner i en egen oversikt.
Disse avvikene utløser ingen endring av arbeidstidene i Wix.

## Konfigurasjon for integrasjonstest

Sett disse variablene for Netlify Functions i et separat deploy-miljø:

- `SUPABASE_URL`, prosjektets HTTPS-origin.
- `SUPABASE_PUBLISHABLE_KEY`, Supabase-prosjektets publiserbare nøkkel.
- `WIX_API_KEY`, en Wix-nøkkel med lesetilgang til terapeutprofiler og kalender.
- `WIX_SITE_ID`, Vaajma-sidens Wix-ID.
- `STILLEPUNKT_WIX_SITE_ID`, Stillepunkt-sidens Wix-ID. Nøkkelen må også ha lesetilgang til Wix Events der.
- `CALENDAR_USERS`, et JSON-objekt med e-postadresser og roller.
  Gyldige roller er `admin`, `therapist` og `rental-manager`.
  Eksempel: `{"admin@example.com":"admin"}`.

Legg inn de godkjente kontoene i Supabase Auth uten å aktivere åpen
registrering. Konfigurer e-postlevering og bruk kodevariabelen
`{{ .Token }}` i malen for innlogging. Innloggingen oppretter ingen nye
kontoer. Kalenderen leser bare arbeidstider til Wix-profiler som samsvarer
med en aktiv administrator- eller terapeutadresse. Rollene returneres
etter innlogging. Templet viser tittel og tidspunkt fra Stillepunkt. Redigering,
romleieadministrasjon og opprettelse av brukere er foreløpig ikke koblet til.

Før produksjon må romreservasjoner lagres transaksjonelt med validering
av rom og tid. Wix-arbeidstid skal synkroniseres server-side, med
klienttimesjekk før endring eller sletting, feilhåndtering og ny forsøk
uten duplikater. Bruk et testmiljø for å verifisere tilgang og synkronisering
før private arbeidsdata tas i bruk.
