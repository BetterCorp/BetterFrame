# License

BetterFrame is **dual-licensed** under one of:

1. **GNU Affero General Public License v3.0 only** (`AGPL-3.0-only`), at your
   option to comply with its terms, **OR**
2. A **Commercial License** from BetterCorp — see [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).

SPDX identifier (used in every `package.json` + `Cargo.toml`):

    AGPL-3.0-only OR Commercial

Pick exactly one path; you cannot mix terms from both.

---

## AGPL-3.0-only path

Copyright © 2024–2026 BetterCorp.

This program is free software: you can redistribute it and/or modify it under
the terms of the GNU Affero General Public License as published by the Free
Software Foundation, **version 3 only**.

This program is distributed in the hope that it will be useful, but WITHOUT
ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS
FOR A PARTICULAR PURPOSE. See the GNU Affero General Public License for more
details.

The full text of AGPL-3.0 is at:

    https://www.gnu.org/licenses/agpl-3.0.txt

For convenience the canonical text is also vendored at [LICENSE-AGPL.txt](LICENSE-AGPL.txt).
If that file is missing or differs from the upstream FSF copy, the upstream
copy controls.

### What AGPL means for your deployment

AGPL is "copyleft over the network". Key obligations:

- If you **distribute** the software (binary or source), you must offer the
  corresponding source under AGPL to recipients.
- If you **modify the software and let users interact with it over a network**
  (e.g. host a BetterFrame admin UI for customers), you must offer those users
  the corresponding modified source under AGPL.
- **Linking restriction**: any program that combines with this code at compile
  or link time must itself be AGPL-compatible (or you must obtain a commercial
  licence — see below).

Internal-only deployments inside one organisation where users are employees
generally do not trigger the network-disclosure clause, but consult your
counsel — AGPL section 13 is read strictly.

## Commercial path

If AGPL is incompatible with your use case — for example you ship a closed
distribution to customers, embed BetterFrame in a proprietary product, or
host it as a SaaS without disclosing modifications — purchase a commercial
licence. See [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md) for terms +
contact.

---

## Third-party licences

BetterFrame uses third-party software (GTK4, GStreamer, WebKitGTK, h3, BSB,
@anyvali/js, htmx, cage, plymouth, etc.) under their respective licences.
Build artefacts include AGPL-compatible licences from those dependencies; the
combined work is distributable under AGPL-3.0-only. Commercial-licence
holders receive an equivalent grant only over BetterFrame's own code —
third-party dependencies remain under their own terms.
