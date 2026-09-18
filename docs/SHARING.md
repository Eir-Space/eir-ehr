# Social Sharing

Share `https://ehr.eir.space/`. The entry page and `/guide.html` include static Open Graph and X large-image metadata with absolute HTTPS URLs, canonical URLs, descriptions, locales and image alternative text. A crawler does not need JavaScript, an account or a demo session. The guide has its own title and canonical URL.

The 1200 x 630 PNG at `apps/web/social/eir-journal-v1.png` combines the existing Eir wordmark and a real screenshot of a fresh fictional clinical workspace. It is checked in and deployed as a public static asset. It never captures a real user's browser or patient data.

To regenerate after an intentional visual change:

```sh
npm ci
npm run terminology:import
npx playwright install chromium
npm run social:generate
```

The generator starts and closes its own local in-memory demo. It does not accept an external target URL or session token. Its HTML/CSS composition is kept in `scripts/generate-social.ts` so contributors can adjust the copy and layout. Inspect the resulting image before publishing. For a replacement after the first release, use a new image filename and update both pages and the test: social platforms cache image URLs independently of the page's HTTP caching policy.

`tests/social.e2e.ts` checks both pages without JavaScript under Facebook, LinkedIn and X crawler user agents. It verifies canonical URLs, metadata, PNG dimensions, file size, MIME type and unauthenticated image delivery. Set `EIR_DEMO_TEST_URL=https://ehr.eir.space` to run against the live site. These are crawler-compatibility checks, not confirmation that each platform has refreshed its cache.

Deploy static changes with the existing Hosting workflow in [HOSTING.md](HOSTING.md); no Cloud Run rebuild is needed for the public custom domain's frontend. Already-shared links may retain an older preview. Request a new scrape through the platform's sharing debugger or inspector, or use a new query string such as `?share=1` when sharing the updated page. The canonical URL remains the homepage.
