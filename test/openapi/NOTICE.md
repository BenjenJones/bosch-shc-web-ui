# Third-party content — Bosch OpenAPI specifications

The `*-local-openapi-v3.yml` files in this directory are **not** part of this
project's MIT-licensed code. They are **verbatim, unmodified** copies of the
official Bosch Smart Home Local API documentation.

- **Source:** https://github.com/BoschSmartHome/bosch-shc-api-docs
  (also served at https://local.apidocs.bosch-smarthome.com/openapi/)
- **Copyright:** © Robert Bosch GmbH / Bosch Smart Home GmbH
- **License:** Creative Commons Attribution-NonCommercial-NoDerivatives 4.0
  International (CC BY-NC-ND 4.0) —
  https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
- **Terms:** subject to Bosch's Terms & Conditions, see
  https://github.com/BoschSmartHome/bosch-shc-api-docs#terms-and-conditions

These specs are redistributed here verbatim (as permitted by CC BY-NC-ND for
non-commercial use) purely as the contract source for the Prism mock server
used by the test suite (see `../scripts/merge-openapi.mjs`).

The generated `_bundled.yml` is a **derivative** of these specs (paths are
patched for testing) and is therefore **git-ignored and never redistributed** —
it exists only transiently at test runtime.

Do not modify these files. If Bosch updates the API, re-fetch fresh verbatim
copies from the source above.
