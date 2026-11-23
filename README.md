# Drive Sync

Sync an Obsidian vault with a folder in your Google Drive using one command, **Sync**. Works on desktop and mobile.

- Notes are stored as plain files under `My Drive/obsidian/<vault name>/`.
- Sync runs only when you ask: the **Sync** command or the ribbon icon.
- If a note changed on two devices, both versions are kept: yours stays the main file and the other is saved next to it as `<name> (conflict YYYY-MM-DD HHmm).md`.
- If a sync fails halfway, run **Sync** again; it finishes the job without duplicates.

**Status:** 1.0.0, submitted to the Obsidian community directory. Tested with a simulated Google Drive (100+ automated tests); real-world testing is ongoing, so back up your vault before the first sync. Report problems in [GitHub issues](https://github.com/danielzangene/obsidian-sync/issues).

## Network use and accounts

This plugin needs a **Google account** and a **Google Cloud OAuth client** that you create yourself. It connects only to Google: `oauth2.googleapis.com` (to get access tokens) and `www.googleapis.com` (Google Drive API). It sends your vault files to your own Google Drive and nothing anywhere else. It collects no telemetry.

The refresh token gives full access to your Google Drive. The client secret and refresh token are kept in Obsidian's secret storage, not in the plugin's data file, and are never synced or logged.

## Install

Requires Obsidian 1.13.2 or later.

- **Community plugins** (once approved): in Obsidian, open _Settings → Community plugins → Browse_, search for **Drive Sync**, then install and enable it.
- **BRAT:** in the BRAT plugin, add the beta plugin `danielzangene/obsidian-sync`.
- **Manual:** download `main.js` and `manifest.json` from the latest release into `<vault>/.obsidian/plugins/drive-sync/`, then enable **Drive Sync** in _Settings → Community plugins_.

## Setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Configure the OAuth consent screen and add your account as a test user.
3. Create an **OAuth client ID** of type **Web application** with the authorized redirect URI `https://developers.google.com/oauthplayground`. Copy the client ID and client secret.
4. In the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground), open the gear icon, select **Use your own OAuth credentials**, enter them, authorize the scope `https://www.googleapis.com/auth/drive`, and exchange the authorization code for tokens. Copy the refresh token.
5. In Obsidian, open _Settings → Drive Sync_ and paste the client ID, client secret and refresh token into their fields. The secret and token are kept in Obsidian's secret storage.

While the consent screen is in **Testing**, Google expires refresh tokens after 7 days. Set it to **In production** for a long-lived token; Google then shows an "unverified app" warning in step 4, which is expected for a personal client.

## Usage

Run **Drive Sync: Sync** from the command palette, or click the ribbon icon. Progress shows in the status bar (desktop) or a notice (mobile), and a summary notice appears at the end. The last 500 actions are logged in `.obsidian/plugins/drive-sync/sync.log`.

**What is synced:** every file in the vault except names starting with `.` (including the config folder, `.trash` and `.git`), `Thumbs.db`, files over 100 MB, Google Docs/Sheets, and remote files whose names Obsidian can't use.

**Settings:** _Remote folder name_ chooses the folder inside `obsidian/` (default: the vault name). Devices that should share a vault must use the same remote folder name.

## Limitations

- Deleting or renaming a note isn't synced; the old file stays on other devices.
- Empty folders aren't synced.
- Conflicts always keep both versions; merge them by hand.

Full list: [PRD §10](docs/PRD.md#10-known-limitations).

## Development

```sh
npm install
npm run dev      # watch build to main.js
npm run check    # typecheck, lint, format check, tests
npm run build    # production build
```

| Document                           | Answers                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| [PRD](docs/PRD.md)                 | What the plugin does and why: requirements, acceptance criteria, limitations |
| [Technical design](docs/DESIGN.md) | How it works: architecture, data model, sync algorithm, Drive integration    |
| [Execution plan](docs/PLAN.md)     | Status, remaining work, risks, conventions                                   |

License: [MIT](LICENSE).
