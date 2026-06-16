# Parley website

The official landing page for Parley. It's a **zero-build static site** — plain
HTML, CSS, and a little vanilla JS — so it has no dependencies and deploys
anywhere that can serve files.

```
website/
  index.html      # the page
  styles.css      # all styling (brand gradient, dark theme, responsive)
  script.js       # nav, scroll-reveal, copy button, media auto-loading
  assets/         # logo + your showcase GIFs/screenshots go here
```

## Run it locally

Any static server works:

```bash
cd website
python3 -m http.server 4178
# open http://localhost:4178
```

## Adding showcase GIFs / screenshots

The page has marked media slots (the hero window and the three "Showcase"
rows). **You don't need to edit any HTML** — just drop a file into `assets/`
with the matching name and it appears automatically:

| Slot                        | Drop a file named                                  |
| --------------------------- | -------------------------------------------------- |
| Hero window                 | `assets/showcase-hero.{gif,png,jpg,webp,mp4}`      |
| "Every word, attributed"    | `assets/showcase-transcript.{gif,png,jpg,webp,mp4}`|
| "Ask mid-conversation"      | `assets/showcase-qa.{gif,png,jpg,webp,mp4}`        |
| "Insight that keeps up"     | `assets/showcase-eval.{gif,png,jpg,webp,mp4}`      |

Notes:
- `.mp4` is detected too and mounts as a muted, looping, autoplaying clip — often
  smaller and crisper than a GIF for screen recordings.
- Slots are `16:9` (hero) / `16:10` (rows); media is `object-fit: cover`. Record
  at roughly those ratios for the cleanest fit.
- Until you add a file, each slot shows a styled placeholder telling you the
  exact filename to use.

To add a brand-new slot, copy a `data-media="..."` figure block in `index.html`
and pick a new name.

## Deploying to GitHub Pages

A workflow at [`.github/workflows/deploy-website.yml`](../.github/workflows/deploy-website.yml)
publishes this folder automatically.

1. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. Push to `main` (any change under `website/`) — the workflow builds and deploys.
   You can also run it manually from the **Actions** tab (`Deploy website`).
3. The default URL will be `https://pathorsai.github.io/parley/`.

## Custom domain with Cloudflare

To serve the site at your own domain (e.g. `parley.pathors.com`) using GitHub
Pages + Cloudflare DNS:

1. **Tell GitHub the domain.** Create `website/CNAME` containing just the
   hostname, e.g.:
   ```
   parley.pathors.com
   ```
   (Or set it under Settings → Pages → Custom domain, which creates the same
   file. Keeping it in `website/` means the Actions deploy preserves it.)

2. **Add the DNS record in Cloudflare** (DNS → Records):
   - **Subdomain** (recommended, e.g. `parley`): add a `CNAME` record
     `parley` → `pathorsai.github.io`.
   - **Apex/root** (`pathors.com`): add `CNAME` `@` → `pathorsai.github.io`
     (Cloudflare flattens this automatically), or use GitHub's four A records:
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.

3. **Proxy + SSL.** You can leave the record **Proxied** (orange cloud). Set
   Cloudflare **SSL/TLS → Overview → Full** (not Flexible — Flexible causes
   redirect loops with Pages). Then in GitHub **Settings → Pages**, wait for the
   domain check to pass and tick **Enforce HTTPS**.

4. Give DNS a few minutes to propagate, then load your domain.

> Tip: if you use a subdomain and proxy through Cloudflare, GitHub's HTTPS
> certificate provisioning can take up to ~24h the first time. If "Enforce
> HTTPS" is greyed out, set the Cloudflare record to **DNS only** (grey cloud)
> until GitHub issues the cert, then flip it back to Proxied.
