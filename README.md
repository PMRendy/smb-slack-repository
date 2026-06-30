# SMB Slack Proxy — Deployment Guide

This tiny Node.js server solves the CORS problem that blocks the BINGO artifact
(running inside claude.ai) from posting directly to Slack's webhook API.

The BINGO game posts to **your proxy**, and the proxy forwards the message to
**Slack** server-to-server, where CORS doesn't apply.

---

## 1. Push this folder to GitHub

1. Create a new GitHub repo (e.g. `smb-slack-proxy`).
2. Upload `server.js` and `package.json` from this folder (or `git push` them).

## 2. Deploy on Render.com

1. Go to https://render.com and sign in (free tier is enough).
2. Click **New +** → **Web Service**.
3. Connect your GitHub account and select the `smb-slack-proxy` repo.
4. Fill in:
   - **Name:** `smb-slack-proxy` (or anything you like)
   - **Region:** Singapore (closest to PH)
   - **Branch:** `main`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Create Web Service**. Render will build and deploy automatically.
6. Once live, you'll get a URL like:
   ```
   https://smb-slack-proxy.onrender.com
   ```

## 3. Test it

Visit `https://smb-slack-proxy.onrender.com/` in your browser — you should see:
```json
{"status":"ok","service":"smb-slack-proxy","time":"..."}
```

Then test the actual Slack post with curl (replace the webhook with your real one):

```bash
curl -X POST https://smb-slack-proxy.onrender.com/slack \
  -H "Content-Type: application/json" \
  -d '{
    "webhookUrl": "https://hooks.slack.com/services/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",
    "payload": { "text": "Test mula sa proxy! 🌙" }
  }'
```

You should see the message land in your Slack channel.

## 4. Plug the proxy URL into the BINGO game

In the BINGO admin **Settings** tab, there's now a **Slack Proxy URL** field.
Paste your Render URL there, e.g.:
```
https://smb-slack-proxy.onrender.com/slack
```
Save settings — all draws, game-start, and winner announcements will now route
through the proxy instead of hitting Slack directly from the browser.

---

## Notes

- **Free tier sleep:** Render's free instances spin down after ~15 minutes of
  inactivity and take a few seconds to wake up on the next request. The first
  Slack post after a quiet period may be slightly delayed — this is normal and
  won't drop the message, just delay it a couple seconds.
- **Security:** This proxy will forward to *any* Slack webhook URL passed to it.
  That's intentional (keeps it simple, reusable across SMB tools like the
  Lottery game too), but don't share the proxy URL outside the team.
- **Logs:** You can view live request logs anytime in the Render dashboard
  under your service → **Logs** tab — useful for debugging if a message doesn't
  land in Slack.
