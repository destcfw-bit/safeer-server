# AL SAFEER — Coolify deployment checklist

Status: source code migration pending. **Do not deploy this repository yet.**

Target domain: `safeer.dropcodejo.com`

Source reference: `destcfw-bit/abshir-server`, branch `main`. Confirm production source revision before copying.

Required isolation:
1. Create a dedicated PostgreSQL database and user for Safeer; never point to 3zwa's database.
2. Create dedicated Redis database/instance and queue prefix.
3. Set new JWT/session secrets and administrator credentials.
4. Configure a separate WhatsApp session, webhook and group IDs. Do not reuse 3zwa's session.
5. Configure Coolify domain and TLS for safeer.dropcodejo.com.
6. Run migrations against the new database only, then test login, commission accounting, weekly close and deletion policies with a test group.
7. Do not copy production balances or customer data without explicit approval.

Never commit real environment variables or API keys. Public repository: audit for secrets before every push.
