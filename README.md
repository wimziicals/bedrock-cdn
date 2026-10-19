# bedrock-cdn

Let players download your Bedrock Dedicated Server's resource packs from a CDN instead of from the server itself.

Bedrock Dedicated Server (BDS) reads an optional `cdn_config.json` file that gives the game a download URL for each resource pack. This repo explains how that file works, and includes a small tool that:

- zips your resource packs
- uploads them to Cloudflare R2 (or other S3-compatible storage)
- checks they're served the way the game requires
- writes `cdn_config.json` for you
- copies your resource and behavior packs onto the server

> [!NOTE]
> `cdn_config.json` isn't officially documented by Mojang. What's here comes from community findings, so it may change between BDS versions.

## Contents

- [How `cdn_config.json` works](#how-cdn_configjson-works)
- [Doing it by hand](#doing-it-by-hand)
- [Using the tool](#using-the-tool)
- [Faster downloads around the world](#faster-downloads-around-the-world)
- [Troubleshooting](#troubleshooting)
- [Credits](#credits)

## How `cdn_config.json` works

When a player joins, BDS normally sends every resource pack through the game connection in small pieces. That's slow for players, and it uses your server's bandwidth.

If there's a `cdn_config.json` in the server's root folder (next to `server.properties`), BDS sends the player a URL for each pack instead, and the game downloads the pack from there.

The file maps each pack to the URL of its zip:

```json
{
	"<pack UUID>_<pack version>": "<URL of the pack's .zip>"
}
```

For example:

```json
{
	"ee8b0be2-0cb1-4a6b-9851-794519abbda2_1.0.0": "https://cdn.example.com/my_pack_v1.0.0.zip"
}
```

- The UUID and version are `header.uuid` and `header.version` from the pack's `manifest.json`.
- **It has to cover every non-vanilla resource pack the world uses**, at exactly the version the world loads. If even one is missing or out of date, BDS ignores the whole file and sends packs the normal way. Players can still join, but downloads are slow again.

### What the download has to look like

The game is strict about how the zip is served:

| Requirement | Details |
| --- | --- |
| Direct download | The URL has to download the file. Redirects are fine if they end at the file. |
| `Content-Type: application/zip` | Not `application/octet-stream` or `application/x-zip-compressed`. |
| `Content-Length` | Has to be present and match the file size exactly. |

The zip also needs `manifest.json` at the top level, not inside a folder.

Check a URL's headers with:

```bash
curl -I -L https://cdn.example.com/my_pack_v1.0.0.zip
```

Links from Google Drive, Dropbox or Discord generally won't work, because they lead to preview pages or expire.

### Updating a pack

Players' games keep the packs they've downloaded, by UUID and version. If you change a pack without changing its version, players who already have it keep the old one. So for every change:

1. Bump `header.version` in the pack's `manifest.json`, and in any `dependencies` in other packs that point to it.
2. Upload the new zip under a new file name.
3. Update the key and URL in `cdn_config.json`, and the version in the world's `world_resource_packs.json`.
4. Restart the server.

The tool does steps 2 and 3 for you.

## Doing it by hand

If you just want to try the feature:

1. Zip the **contents** of your resource pack folder: select the files inside it, not the folder itself.
2. Upload the zip somewhere that meets the [requirements](#what-the-download-has-to-look-like).
3. Create `cdn_config.json` next to `server.properties`, with an entry for every resource pack the world uses.
4. Restart the server.

## Using the tool

### What you need

- [Bun](https://bun.sh) 1.2 or newer
- A Cloudflare account. R2's free tier includes 10 GB of storage and 10 million reads a month, and downloads cost nothing.
- A Bedrock Dedicated Server

### 1. Set up Cloudflare R2

1. In the Cloudflare dashboard, open **R2 Object Storage** and click **Create bucket**. Give it a lowercase name, and leave Location on Automatic and the storage class on Standard.
2. Open the bucket's **Settings** and enable its **Public Development URL** (r2.dev). Copy the URL. It's fine for testing; for a live server, [use a custom domain](#faster-downloads-around-the-world).
3. Create an API token with **Object Read & Write** permission on your bucket (from the API tokens page linked on the R2 Object Storage overview). Copy its **Access Key ID** and **Secret Access Key**. Cloudflare only shows the secret once.
4. Copy your **Account ID** from **Account Details** on the R2 Object Storage overview page.

### 2. Install and configure

```bash
git clone https://github.com/wimziicals/bedrock-cdn.git
cd bedrock-cdn
bun install
```

Copy `.env.example` to `.env` and fill it in:

| Setting | Value |
| --- | --- |
| `R2_ACCOUNT_ID` | Your Cloudflare Account ID |
| `R2_ACCESS_KEY_ID` | The API token's Access Key ID |
| `R2_SECRET_ACCESS_KEY` | The API token's Secret Access Key |
| `R2_BUCKET` | The bucket's name |
| `R2_PUBLIC_URL` | The bucket's public address, without a trailing slash: its r2.dev URL or your custom domain |

Copy `config.example.json` to `config.json` and point it at your server and packs:

```json
{
	"server": "servers/bedrock_server",
	"resourcePacks": ["packs/resource_pack"],
	"behaviorPacks": ["packs/behavior_pack"]
}
```

| Setting | Value |
| --- | --- |
| `server` | Your BDS folder, the one with `server.properties`. Optional: see [Without a server](#without-a-server). |
| `resourcePacks` | Your resource pack folders. List every one the world uses. |
| `behaviorPacks` | Your behavior pack folders. Optional. |
| `exclude` | Optional. Top-level files and folders that are never shipped. Defaults to `src`, `node_modules`, `package.json`, `package-lock.json`, `bun.lock`, `tsconfig.json`, `.git` and `.gitignore`. |

Paths can be absolute, or relative to this folder. `packs/` is ignored by Git, so it's a handy place to keep them.

The world has to exist before you deploy, so start the server once first.

### 3. Build, upload and deploy

| Command | What it does |
| --- | --- |
| `bun run build` | Zips each resource pack into `output/`. It stops if packs that depend on each other disagree about their versions. |
| `bun run upload` | Uploads the zips with `Content-Type: application/zip`, checks the public URLs serve them correctly, and writes the URLs into the server's `cdn_config.json`. |
| `bun run deploy` | Copies your packs into the server's `resource_packs/` and `behavior_packs/`, and sets their versions in `world_resource_packs.json` and `world_behavior_packs.json`. |
| `bun run release` | Runs all three. If one fails, the rest don't run. |

Then restart the server.

**How it handles versions and files:**

- **Zip names** look like `<pack folder>_v<version>_<hash>.zip`. The hash comes from the zip's contents, so a changed pack always gets a new URL and a CDN can never serve an old copy.
- **Repeat uploads:** `upload` skips zips that are already in the bucket.
- **Changed packs:** `upload` refuses to upload changed contents under a version that's already published, because players who have that version won't download it again. Bump the version, or pass `--force` to upload anyway: `bun run upload --force`.
- **What deploy copies:** it replaces each pack's folder on the server, leaving out the [`exclude`d](#2-install-and-configure) development files. It only copies files, so if your behavior pack is written in TypeScript, compile it first.
- **Missing packs:** `deploy` warns if `cdn_config.json` doesn't cover every resource pack in the world.

Behavior packs aren't downloaded by players, so they're never uploaded. Behavior pack changes only need `bun run deploy` and a restart.

### Without a server

If your server is somewhere this tool can't reach, like a hosting provider, leave out `"server"`. `upload` then writes `output/cdn_config.json` for you to copy next to the server's `server.properties`. `deploy` needs a server, so you'll copy the packs over yourself.

### Other storage providers

The upload uses the S3 API, so other S3-compatible storage should work too. Set `R2_ENDPOINT` in `.env` to the provider's S3 endpoint; you can then leave out `R2_ACCOUNT_ID`. `upload` checks the public URL either way, so you'll know if the headers aren't right.

## Faster downloads around the world

The r2.dev URL is fine for testing, but Cloudflare rate-limits it and doesn't cache it. Every download comes from the bucket's region, wherever the player is.

With a custom domain, Cloudflare caches the zip in data centers near your players:

1. **Add your domain to Cloudflare** if it isn't already. The free plan is fine. You'll switch the domain's nameservers at your registrar.
2. **Connect it to the bucket.** Open the bucket's **Settings → Custom Domains → Connect Domain**, and enter a subdomain like `cdn.example.com`. Wait until its status is Active.
3. **Add a Cache Rule** so the zips stay cached. On the domain, open **Caching → Cache Rules → Create rule** and set:
   - **Filter:** Hostname equals `cdn.example.com`
   - **Cache eligibility:** Eligible for cache
   - **Edge TTL:** Ignore cache-control header and use this TTL, 1 month or longer

   This is safe because every version has its own file name, so a cached file never goes out of date.
4. **Turn on Tiered Cache.** Open **Caching → Tiered Cache** and enable **Smart Tiered Caching**. It's free. When a data center doesn't have the file, it fetches it from a larger Cloudflare data center instead of from the bucket.
5. **Point the tool at the domain.** Set `R2_PUBLIC_URL` in `.env` to `https://cdn.example.com`, run `bun run upload` to rewrite the URLs in `cdn_config.json`, and restart the server.
6. Once that works, you can turn off the bucket's r2.dev URL.

## Troubleshooting

**Players still download packs from the server**

- Run `bun run deploy` and look for a warning about `cdn_config.json`. Every resource pack the world uses needs a URL, at the version the world loads.
- Make sure you restarted the server after changing `cdn_config.json`.
- Check the URL's headers with `curl -I -L <url>`.

**`upload` errors**

| Message | Fix |
| --- | --- |
| Missing R2 settings | Copy `.env.example` to `.env` and fill in every value. |
| `...returned 401` or `403` | Public access isn't on for the bucket. Enable the r2.dev URL or a custom domain. |
| `...returned 404` | `R2_PUBLIC_URL` isn't this bucket's public address. |
| `...is served as "...", but it has to be "application/zip"` | Something between R2 and the player is changing the content type, like a Transform Rule on your domain. |
| `...has changed, but vX is already published` | Bump the version in the pack's `manifest.json` and rebuild, or pass `--force`. |
| Access key or signature errors | Check `R2_ACCOUNT_ID`, the token's keys, and that the token has Object Read & Write on this bucket. |

**`build` errors**

| Message | Fix |
| --- | --- |
| `...depends on X vA, but X is vB` | Update the version in that pack's `dependencies` to match. |
| `...is missing, or has no header.uuid and header.version` | Check the path in `config.json` points at the pack folder, the one with `manifest.json`. |

**`deploy` errors**

| Message | Fix |
| --- | --- |
| The world "..." doesn't exist yet | Start the server once to create it, and check `level-name` in `server.properties`. |

## Credits

How `cdn_config.json` works, and what the game requires from the download, were documented by [xKingDark](https://gist.github.com/xKingDark/e80569d688e692ee11e161b427f6e49f).
