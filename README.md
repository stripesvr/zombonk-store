# Zombonk Mod Store

A mod store hosted free on GitHub Pages, with a site for submitting, reviewing and publishing mods.

## Links

- **Store address** (enter in the mod manager's mod store setting): https://stripesvr.github.io/zombonk-store/
- **Mod store site (submit, review and publish mods):** https://stripesvr.github.io/zombonk-store/ (`/upload.html` goes to the same page)
- **Manifest:** https://stripesvr.github.io/zombonk-store/manifest.json

## Publish it

1. In the repository, open **Settings > Pages**, set the source to **Deploy from a branch**, and choose `main` and `/ (root)`.
2. After a minute or two, the manifest link above works.

The empty `.nojekyll` file makes GitHub Pages serve every file as is. Keep it.

## Add a mod

Only add mods you made or have the creator's permission to share. The repository is public, so anyone can download them.

### From the site

Open the store site, enter the upload password, drop the mod zip, fill in the details and press **Release**. The page repacks the zip and sends it to the upload Worker in `worker/`, which checks the password, works out the size and sha256, and commits the zip and manifest entry. Each mod in the store list has **Update** (a dropdown to release a new version) and **Delete**.

Anyone can press **Continue as guest** to submit a mod instead. Submissions wait on the `submissions` branch, which GitHub Pages doesn't serve. After signing in, the **Submissions** card lists them with **Approve and release**, **Download** and **Reject**. Guest zips are limited to 50 MB, and at most 50 can wait at once.

### From the command line

```
python add_mod.py "C:\path\to\MyMod.zip" --name "My Mod" --creator stripesvr --version 1.0.0 --summary "What it does" --tags visuals,fun
```

The folder or `.zip` needs a matching `.utoc`, `.ucas` and `.pak`. Run it from your clone of this repository, since it writes `mods/` and `manifest.json` next to itself. Run it again with the same name to update a mod, then commit and push.

## Upload server setup

The password and the GitHub token are Cloudflare Worker secrets, never in this repository or the page. `.github/workflows/deploy-worker.yml` deploys the Worker to `https://zombonk-upload.wannabeweirdguy.workers.dev` and needs these repository secrets (**Settings > Secrets and variables > Actions**):

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, the same kind as the Driftrinth store uses
- `UPLOAD_PASSWORD`, the password for signing in on the site
- `STORE_GITHUB_TOKEN`, a [fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to this repository with **Contents: Read and write**

Then run **Actions > deploy upload worker > Run workflow**. To change the password, update `UPLOAD_PASSWORD` and run the workflow again.
