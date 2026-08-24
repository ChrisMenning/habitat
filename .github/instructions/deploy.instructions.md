---
applyTo: "**"
---

# Bay Hive — Manual Deployment

CI/CD via GitHub Actions is currently broken (Tailscale OAuth tag:ci permission issue on Free plan). Use manual deployment below.

## Server
- **Host**: `192.168.4.45` (Aspire GX-785, home LAN — must be on same network or Tailscale)
- **User**: `mcmudgeon`
- **SSH key**: `C:\Users\chris\Nextcloud\dev\habitat\key` (will prompt for passphrase)
- **App path**: `/home/mcmudgeon/bayhive/`
- **Service**: `bayhive.service` (systemd)

## Manual Deploy Steps

### 1. Create archive (run from repo root)
```powershell
Set-Location "C:\Users\chris\Nextcloud\dev\habitat"
tar -czf "$env:TEMP\bayhive-deploy.tar.gz" `
  --exclude="./.git" `
  --exclude="./snapshots/cache" `
  --exclude="./snapshots/inat-*.json" `
  --exclude="./node_modules" `
  .
```

### 2. Upload to server
```powershell
scp -i "C:\Users\chris\Nextcloud\dev\habitat\key" `
  -o StrictHostKeyChecking=no `
  "$env:TEMP\bayhive-deploy.tar.gz" `
  mcmudgeon@192.168.4.45:/tmp/bayhive-deploy.tar.gz
```

### 3. Extract on server
```powershell
ssh -i "C:\Users\chris\Nextcloud\dev\habitat\key" `
  -o StrictHostKeyChecking=no `
  mcmudgeon@192.168.4.45 `
  "cd /home/mcmudgeon/bayhive && tar -xzf /tmp/bayhive-deploy.tar.gz --strip-components=1 && rm /tmp/bayhive-deploy.tar.gz"
```

### 4. Restart service
```powershell
ssh -i "C:\Users\chris\Nextcloud\dev\habitat\key" `
  -o StrictHostKeyChecking=no `
  mcmudgeon@192.168.4.45 `
  "sudo systemctl restart bayhive && systemctl is-active bayhive"
```

## Environment Variables (server)
API keys are NOT in the repo. They live in the systemd service override:
`/etc/systemd/system/bayhive.service.d/override.conf`

To add/update keys on the server:
```bash
sudo systemctl edit bayhive --force
# Add or edit:
# [Service]
# Environment="NOAA_CDO_TOKEN=..."
# Environment="EBIRD_API_KEY=..."
# Environment="NASS_API_KEY=..."
sudo systemctl daemon-reload && sudo systemctl restart bayhive
```

## Notes
- `ssh-agent` is not running on this Windows machine — passphrase is typed manually each time
- DO NOT use `Compress-Archive` — it produces zip and flattens paths
- `snapshots/climate-normals-*.json` and `snapshots/observed-temps-*.json` ARE in the repo and deploy
- `snapshots/cache/` and `snapshots/inat-*.json` are gitignored — server builds these at runtime
- To fix CI: switch `tailscale/github-action@v2` to use `authkey: ${{ secrets.TAILSCALE_AUTH_KEY }}` (remove oauth lines and tags), generate a reusable+ephemeral auth key from https://login.tailscale.com/admin/settings/keys, store as `TAILSCALE_AUTH_KEY` secret
