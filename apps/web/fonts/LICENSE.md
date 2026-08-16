# Fonts vendored into this app

All three families are licensed under the **SIL Open Font License 1.1** (OFL), which permits
bundling and redistribution with the software. Only the `latin` subsets are committed; the files
are the woff2 builds published by Google Fonts.

| Family | Files | Upstream | License |
|---|---|---|---|
| Fraunces | `fraunces-normal-400-700.woff2`, `fraunces-italic-400-700.woff2` | github.com/undercasetype/Fraunces | OFL 1.1 |
| Inter | `inter-normal-400-700.woff2` | github.com/rsms/inter | OFL 1.1 |
| IBM Plex Mono | `ibm-plex-mono-normal-400.woff2`, `ibm-plex-mono-normal-500.woff2` | github.com/IBM/plex | OFL 1.1 |

Fraunces and Inter are variable (weight axis 400–700). They are loaded with `next/font/local`, so
no request ever leaves the origin at runtime — the CSP's `font-src 'self'` is enforceable.
