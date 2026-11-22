# DeepSeek Web · dsh-deepseek-web-chat

[中文](README.md) | English

A DeepSeek Harness plugin that adds a sidebar entry opening the free
[chat.deepseek.com](https://chat.deepseek.com/) web app in the centre panel —
your own web sign-in, free quota and conversation history, no API credits used.

> Unofficial plugin, not affiliated with DeepSeek. It only relays your own
> browser requests on this machine and proxies no server-side data.

## Install

```sh
dsh plugin --profile desktop add github:xubin0628/dsh-deepseek-web-chat
```

Or use **Settings → Plugins → Add plugin** and paste
`github:xubin0628/dsh-deepseek-web-chat`. Refresh the page; the sidebar shows
**DeepSeek Web**. A local directory works too:
`dsh plugin --profile desktop add link:/absolute/path/to/dsh-deepseek-web-chat`.

## Why a reverse proxy

The site sends `content-security-policy: frame-ancestors 'none'`, so no page may
frame it, and its API paths are absolute (`/api/v0/...`), which would hit the
Harness origin instead. The plugin therefore runs a **loopback-only** reverse
proxy and serves the whole site from its own origin:

| Blocker | Handling |
| --- | --- |
| `frame-ancestors 'none'` | The proxy re-sends the document without CSP / X-Frame-Options / HSTS |
| Assets on `fe-static.deepseek.com` with deepseek-only CORS | CDN URLs in HTML/JS/CSS are rewritten to same-origin `/_cdn/...`, and `integrity` / `crossorigin` are stripped |
| The bundle treats an IP host as dev | That branch is rewritten to production so no debug headers reach the API |
| `/api/v0/*` | Same-origin through the proxy, streamed as-is (SSE, uploads, PoW headers) |
| Sign-in that lasts | Session cookies are persisted in the DSH credential store and reloaded into the jar after a restart |
| Site isolation | The site uses `localhost` while the UI is on `127.0.0.1`, so local storage never mixes |
| Header pollution | Whitelist forwarding; HSTS, alt-svc and Access-Control-* are never passed through |

The proxy listens on `127.0.0.1` and `[::1]` only, keeps no request log, and
never forwards Harness cookies upstream.

## Usage

1. Click **DeepSeek Web** in the sidebar.
2. Sign in once with your phone number and code (or password).
3. You stay signed in across Harness restarts. The header has reload,
   open-in-new-tab and import sign-in; **Forget saved sign-in** clears the
   stored session.

The toolbar also shows whether you are really signed in: the plugin asks
`/api/v0/users/current` and only reports signed-in on `code: 0`.

## Known limits

- Loopback only; never exposed to the network.
- A DSH account (`platform.deepseek.com`) and the web app
  (`chat.deepseek.com`) are separate account systems with incompatible tokens,
  so the plugin cannot sign the web app in with your DSH account.
- The site's WeChat QR login is hidden: WeChat only accepts
  `chat.deepseek.com` as the callback domain, and the site falls back to a
  `chat-dev` test domain under a localhost origin. Making it work would need a
  hosts entry, a trusted local CA and port 443 — system-level changes this
  plugin deliberately avoids. Use the phone number or password instead.
- Voice read-aloud uses a websocket and is not proxied.
- If a site redesign breaks the rewrites, the panel goes blank; open-in-new-tab
  still works.

## Security and privacy

- Bound to loopback only; unreachable from the LAN or the internet.
- No request logging; neither requests nor responses are written to disk.
- Site cookies live only in this machine's DSH credential store
  (`deepseek-web-chat/site-session`), equivalent to signing in to
  chat.deepseek.com in your browser. Remove them with **Forget saved sign-in**
  or by deleting that credential record.
- The proxy strips upstream CSP / X-Frame-Options / HSTS and rewrites CDN assets
  to same-origin so the site can be framed in this panel. This affects only the
  page inside the panel, not your system or other browsers.
- Your DSH credentials are never sent anywhere outside Harness.

## License

[MIT](LICENSE) © xubin0628

The plugin relies on DeepSeek's own web frontend, whose code is not part of this
repository and remains the property of its owners.
