# CADRA — AI Creative Studio

## Free website deployment with GitHub Pages

The public website is published from `public/` using GitHub Actions. Orders open WhatsApp with the customer's form details; customers must press **Send** in WhatsApp to submit the message. GitHub Pages does not run the Node.js backend, so the admin dashboard, saved orders, and Telegram alerts are not available in this free setup.

1. Push changes to the `main` branch on GitHub.
2. In the GitHub repository, open **Settings → Pages** and set the build/deployment source to **GitHub Actions**.
3. Open the **Actions** tab and wait for **Deploy static website to GitHub Pages** to finish successfully.
4. In **Settings → Pages → Custom domain**, enter `cadrastudio.online.ge` and save.
5. At the domain provider, add the DNS record GitHub Pages requests for `cadrastudio.online.ge`. For a subdomain, this is normally a CNAME pointing to `likunanin.github.io`; use the exact DNS host/value shown by GitHub or your domain provider.
6. Wait for DNS to update, then return to **Settings → Pages** and enable **Enforce HTTPS** when that option becomes available.

The workflow publishes only the website files in `public/` and deliberately omits `admin.html`. `public/CNAME` configures the custom domain, and the static `robots.txt` and `sitemap.xml` use that domain.

## Run the Node.js backend locally

The Node.js backend remains in this repository for local testing or a future Node.js host. It is not part of the free GitHub Pages deployment. The public form always sends the customer to WhatsApp, so it does not save orders to the local JSON file.

1. Install Node.js 18 or newer.
2. In PowerShell, from this folder, run:

   ```powershell
   $env:ADMIN_PASSWORD="choose-a-local-password"
   node server.js
   ```

3. Open `http://localhost:3000`. The backend API and `/admin.html` dashboard are available locally; orders submitted through the public form are sent to WhatsApp instead of being stored.

## Project files

- `public/index.html`, `public/styles.css`, and logo assets: public website
- `.github/workflows/pages.yml`: GitHub Pages deployment workflow
- `server.js` and `public/admin.html`: Node.js order API and admin dashboard, for local use or future backend hosting
- `.env.example`: environment-variable names for a future Node.js host; this simple server does not load `.env` automatically
- `data/`: local order records; excluded from Git

The domain's social preview image is referenced as `public/og-image.jpg`; add that image before launch if you want a custom preview when sharing the website.

Phone / WhatsApp: +995 593 415 541
