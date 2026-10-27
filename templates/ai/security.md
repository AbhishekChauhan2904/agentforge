# Security Rules

Non-negotiable. Every agent follows these.

- Never store JWT or session tokens in localStorage; use httpOnly, secure, sameSite cookies.
- Never hardcode or log secrets; use environment variables. `.env` must be git-ignored.
- Validate all input on the server. Deny by default for authorization.
- Check both role and ownership on every protected resource.
- Use parameterized queries / safe ORM calls only.
- CORS: explicit origin allow-list.
- Rate-limit authentication endpoints.
