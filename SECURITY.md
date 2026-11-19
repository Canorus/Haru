# Security policy

Do not commit production `.env` files, database exports, `data/store.json`,
TLS/private keys, session cookies, shortcut tokens, CalDAV credentials, or real
deployment topology. Use `.env.example` and the files under `deploy/` as
templates only.

Shortcut tokens and session tokens should be revoked immediately if exposed.
Rotate `HARU_CREDENTIAL_KEY` only with a migration plan because it encrypts
stored CalDAV credentials.

Report security issues privately to the repository owner instead of opening a
public issue containing credentials or user data.
