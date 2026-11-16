# Experimental resource adapter

`fips-resource-client.ts` is copied verbatim from the companion
`soytec/napplet-soy` branch `codex/fips-resource-integration`,
`packages/resource-client/src/index.ts`. Profile: `soy.fips/1`; no NAP standard
is claimed and no networking code is included. Keep it byte-identical when
updating the companion integration.

SHA-256: `c007ca8d70af2045956f0eed4110cf1e207c4a0c2f266dd42480e9b4863cfd75`.

This is first-party integration code. The separately vendored FIPS/TCP transport
and its MIT provenance live in the shell, outside the napplet bundle.
