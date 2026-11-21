# Cranioklinikken · romkalender

`preview/` er den klikkbare prototypen med eksempeldata. Netlify-oppsettet
bygger `public/` og Netlify Functions fra `netlify/functions/`.

Dette arbeidet innfører innloggingslenke på e-post og en innlogget ukevisning av egendefinerte
Wix-arbeidstider. Det er et utviklingstrinn før romreservasjoner og Wix-synk
kan tas i bruk. Ukevisningen viser individuelt registrerte arbeidstider fra
Wix. Administrator kan tildele Mandibula eller Maxilla til eksisterende Wix-perioder når Supabase-migreringen er kjørt og servernøkkelen er satt. Romtildelingen endrer ingen Wix-tider. Wix er fasit. Administrator
ser overlapp, ugyldige intervaller og ukjente timeplaner i en egen oversikt.
Disse avvikene utløser ingen endring av arbeidstidene i Wix.

## Konfigurasjon for integrasjonstest

Sett disse variablene for Netlify Functions i et separat deploy-miljø:

- `SUPABASE_URL`, prosjektets HTTPS-origin.
- `SUPABASE_PUBLISHABLE_KEY`, Supabase-prosjektets publiserbare nøkkel.
- `SUPABASE_SECRET_KEY`, servernøkkelen for romtildeling. Den må ligge i Functions-miljøet.
- `WIX_API_KEY`, en Wix-nøkkel med lesetilgang til terapeutprofiler og kalender.
- `WIX_SITE_ID`, Vaajma-sidens Wix-ID.
- `STILLEPUNKT_WIX_SITE_ID`, Stillepunkt-sidens Wix-ID. Nøkkelen må også ha lesetilgang til Wix Events der.
- `CALENDAR_ADMIN_EMAIL`, administratorens godkjente adresse.

Kjør alle Supabase-migreringene. Konfigurer e-postlevering og bruk følgende lenke
i både Confirm sign up og Magic link / OTP:

```html
<a href="{{ .SiteURL }}/?token_hash={{ .TokenHash }}">Åpne romkalenderen</a>
```

Administrator logger inn med adressen i `CALENDAR_ADMIN_EMAIL` og legger til
godkjente e-postadresser under Administrer brukere. Å legge inn en adresse sender
ingen e-post. Supabase oppretter kontoen ved første forespørsel for en godkjent
adresse. Første gangs innlogging for en godkjent bruker kan kreve at e-postregistrering
er aktivert i Supabase. Romkalenderen kontrollerer tilgang både før utsending og etter
verifisering.
Kalenderen leser bare arbeidstider til Wix-profiler som samsvarer
med en aktiv administrator- eller terapeutadresse. Rollene returneres
etter innlogging. Templet viser tittel og tidspunkt fra Stillepunkt. Redigering av arbeidstid er foreløpig ikke koblet til.

Før produksjon må romreservasjoner lagres transaksjonelt med validering
av rom og tid. Wix-arbeidstid skal synkroniseres server-side, med
klienttimesjekk før endring eller sletting, feilhåndtering og ny forsøk
uten duplikater. Bruk et testmiljø for å verifisere tilgang og synkronisering
før private arbeidsdata tas i bruk.

Kjør migreringen i `supabase/migrations/` før romtildeling tas i bruk.
Databasen avviser overlapp for samme rom, også ved samtidige oppdateringer.
En tildeling som ikke lenger stemmer med Wix-perioden vises som ufordelt.
En gammel tildeling kan fortsatt blokkere et rom inntil den er oppdatert
eller ryddet bort av en databaseadministrator.

Ny arbeidstid kan reserveres av innloggede terapeuter når migreringene
er kjørt og `ENABLE_WIX_WRITES=true` er satt. Hold funksjonen av i produksjon
inntil endepunktet er testet med en separat Wix-testplan. Wix-nøkkelen trenger
skrivetilgang til kalenderen. Supabase låser rom og terapeut før Wix-kallet.
Ved uklart svar beholdes reservasjonen i status «Avventer Wix». Ved å sende
inn samme reservasjon i samme nettleserfane brukes den samme forespørsels-ID-en.
Redigering, sletting og romleie kan ikke gjøres gjennom dette endepunktet.

Romansvarlige og administrator kan legge til leietakere, reservere, endre
og frigi romleie. Romleie lagres bare i romkalenderen og omfattes av samme
romsperre som arbeidstid. Rollen for Kjetil og Daniella er `rental-manager`.
Miras eksisterende romleie må legges inn i databasen ved oppstart.
