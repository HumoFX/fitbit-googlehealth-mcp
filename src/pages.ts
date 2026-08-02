/**
 * The public face of a deployment: a landing page and the two policy
 * documents the Google consent screen links to. Served from the Worker so
 * they share an origin with the OAuth callback — and so a deployment that
 * later moves to a custom domain carries them along unchanged.
 */

const LOGO = `<svg viewBox="0 0 512 512" width="72" height="72" aria-hidden="true"><rect width="512" height="512" rx="124" fill="#0E7C7B"/><polyline points="139,256 190,256 223,176 264,344 304,205 337,256 373,256" fill="none" stroke="#fff" stroke-width="29" stroke-linecap="round" stroke-linejoin="round"/><circle cx="103" cy="256" r="40" fill="#fff"/><circle cx="409" cy="256" r="40" fill="#fff"/></svg>`;

const STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:48px 24px;font:16px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c1c1c;background:#fff}
main{max-width:640px;margin:0 auto}
h1{font-size:28px;font-weight:600;margin:20px 0 8px}
h2{font-size:19px;font-weight:600;margin:32px 0 8px}
p,li{color:#3d3d3d}
a{color:#0E7C7B}
code{background:#f2f2f2;padding:2px 6px;border-radius:4px;font-size:14px}
.lede{font-size:18px;color:#555}
.meta{margin-top:40px;padding-top:20px;border-top:1px solid #e3e3e3;font-size:14px;color:#666}
@media(prefers-color-scheme:dark){
body{color:#e8e8e8;background:#141414}
p,li{color:#c2c2c2}.lede{color:#a8a8a8}
code{background:#252525}.meta{border-color:#2e2e2e;color:#8f8f8f}}`;

function page(title: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${STYLE}</style></head>
<body><main>${body}
<p class="meta">Open source under the MIT licence ·
<a href="https://github.com/HumoFX/fitbit-googlehealth-mcp">source code</a> ·
<a href="/privacy">privacy</a> · <a href="/terms">terms</a></p>
</main></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

/** Must match the app name on the Google OAuth consent screen. */
const APP_NAME = 'Health Bridge MCP';

export function landingPage(): Response {
  return page(
    APP_NAME,
    `${LOGO}
<h1>${APP_NAME}</h1>
<p class="lede">A personal bridge between your AI assistant and your own
Google Health data.</p>
<h2>What this app does</h2>
<p>${APP_NAME} is a <a href="https://modelcontextprotocol.io">Model Context
Protocol</a> server. Once you connect it to an AI assistant such as Claude
and sign in with your Google account, the assistant can read your health
data — sleep, activity, heart rate and variability, body measurements,
nutrition — and answer questions about it in plain language. It can also
write entries back: log a meal from a photo, record water, weight, a
workout or a night of sleep.</p>
<p>It exists so health data you already have stops being trapped behind an
app you have to scroll through, and becomes something you can simply ask
about. It requests access to your Google Health data for that purpose and
no other.</p>
<h2>Connecting</h2>
<p>Add this URL as a custom connector, then sign in with the Google account
your health data lives in:</p>
<p><code>${'{'}this deployment's URL{'}'}/mcp</code></p>
<p>Everyone who connects authorizes their own account and sees only their
own data.</p>
<h2>Your data</h2>
<p>Only OAuth tokens and a one-hour response cache are stored. Nothing is
sold, shared or used for training. Revoke access at any time from your
<a href="https://myaccount.google.com/permissions">Google account
permissions</a>. See the <a href="/privacy">privacy policy</a> for
details.</p>`,
  );
}

export function privacyPage(): Response {
  return page(
    `Privacy policy · ${APP_NAME}`,
    `<h1>Privacy policy</h1>
<p class="lede">How this server handles your data.</p>
<h2>What it is</h2>
<p>An open-source Model Context Protocol server, deployed and operated by
an individual, that relays your own Google Health data to an AI assistant
you connect. It has no accounts of its own and no purpose beyond that.</p>
<h2>What is accessed</h2>
<p>Only the Google Health data covered by the scopes you approve: sleep,
activity, heart rate and variability, body measurements, nutrition and
hydration, oxygen saturation, respiratory rate, skin temperature, VO2 max,
your profile settings and paired devices. Data is read when your assistant
makes a request for you, and written only when you ask it to log
something.</p>
<h2>What is stored</h2>
<ul>
<li><strong>OAuth tokens</strong> — what lets the server act on your behalf.</li>
<li><strong>Cached responses</strong> — kept one hour, then expired.</li>
</ul>
<p>There is no analytics, no logging of health data, and no other
database.</p>
<h2>Who it is shared with</h2>
<p>Only the parties already in your request: Google, as the source, and the
assistant you connected, because you asked it something that needs the
data. Never sold, never used for advertising, never used to train any
model by this server, never shared with anyone else.</p>
<h2>Multiple users</h2>
<p>A deployment may serve several people. Each authorizes their own Google
account; tokens and cache are stored per person, and one person's request
can never return another's data.</p>
<h2>Your controls</h2>
<p>Revoke access at any time at
<a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>,
which immediately invalidates the stored tokens. Cached data expires within
an hour regardless. To have stored tokens deleted sooner, contact whoever
operates the deployment you use.</p>`,
  );
}

export function termsPage(): Response {
  return page(
    `Terms of service · ${APP_NAME}`,
    `<h1>Terms of service</h1>
<p class="lede">Free, as-is, from an individual — not a company.</p>
<h2>Using it</h2>
<p>Connect only Google accounts you own or are authorized to use, for your
own health data. Do not rely on it for anything safety-critical.</p>
<h2>Not medical advice</h2>
<p>The data comes from consumer wearables and is estimated, not clinical.
Nothing this server returns is medical advice, diagnosis or treatment.
Consult a qualified professional for any health decision.</p>
<h2>Availability</h2>
<p>The service may change, break or shut down at any time without notice.
Your health data lives in Google Health, not here, so losing access to this
server does not affect it.</p>
<h2>Third parties</h2>
<p>Your use is also governed by the terms of Google Health and of whichever
assistant you connect. These terms do not override them.</p>
<h2>Liability</h2>
<p>Provided without warranty of any kind. To the maximum extent permitted
by law, the author is not liable for any damages arising from use of the
service, including inaccurate data, incorrect log entries, unavailability
or loss of access.</p>`,
  );
}
