---
title: Knooz
emoji: 🍊
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

# Knooz Store

Arabic/English storefront for Knooz food products, featuring the Rashfa specialty coffee collection (Colombian, Ethiopian, Brazilian drip boxes) plus pantry essentials.

## Local setup

1. Install Node.js 20.12 or newer and PostgreSQL.
2. Set `DATABASE_URL` in `.env`.
3. Install dependencies with `npm install`.
4. Create the database, then run `npm run db:migrate`.
5. Start the server with `npm start` and open `http://127.0.0.1:3026`.
6. Run the tests with `npm test`.

## Install as an app (PWA)

The site is installable on phones and desktops (Chrome / Edge):

- Mobile: home-screen icon, opens without browser chrome.
- Desktop: installs as a standalone window app.
- Requires HTTPS in production (localhost works for testing).
- Manifest: `/manifest.webmanifest` · Service worker: `/sw.js`.

While electronic payment is being connected, customers can order through WhatsApp. Set `CONTACT_WHATSAPP` in `.env` to a Saudi number such as `9665XXXXXXXX`.

## Safe launch defaults

Online checkout remains unavailable unless all of the following are true:

- The product catalog and prices have been reviewed and `CATALOG_APPROVED=true`.
- The operator explicitly enables `CHECKOUT_ENABLED=true`.
- A payment method is enabled (`MANUAL_PAYMENT_ENABLED=true` with bank details, `COD_ENABLED=true`, or a future card gateway).

Keep checkout submission disabled until prices, delivery, tax, inventory, and payment details are verified.
