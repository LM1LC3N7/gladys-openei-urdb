# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
ships no third-party code besides its npm dependencies (the Gladys integration
SDK, Apache-2.0).

## Utility Rate Database (data, not code)

The tariffs are read at run time from the Utility Rate Database (URDB) of
OpenEI, through its public API version 7 (`https://api.openei.org/utility_rates`,
documented at <https://openei.org/services/doc/rest/util_rates/?version=7>).
The data are collected and updated for the US Department of Energy and hosted
by the National Renewable Energy Laboratory (NREL) on OpenEI.org, whose
content "is available under Creative Commons Zero unless otherwise noted"
(**CC0 1.0**, public domain dedication,
<https://creativecommons.org/publicdomain/zero/1.0/>). No attribution is
required; it is given here as a courtesy.

The files of `test/fixtures/` are real URDB records read on 2026-11-11
(PG&E E-TOU-C region P and E-1 region V, APS R-3, the residential tariffs in
effect for ZIP code 85004), kept unchanged except for the `revisions` field of
the search answer, under the same CC0 dedication.

No code of OpenEI, NREL or of any URDB client was used: the parser and the
pricing (`src/tariff.js`, `src/pricing.js`) are written in JavaScript from the
API documentation and the records themselves.
