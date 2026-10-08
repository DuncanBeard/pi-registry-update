# pi-registry-update

Registry-aware updates for [pi](https://pi.dev) when your npm registry holds back newly published
packages, for example a corporate npm proxy that only serves packages older than 7 days.

## The problem

`pi update` always installs the newest release that pi.dev announces, using your npm configuration.
A registry with a minimum-release-age ("cooldown") policy doesn't have that release yet, so the
update fails:

```
npm error 404 Not Found - GET https://<your registry>/@earendil-works/pi-tui/-/pi-tui-1.1.0.tgz
```

pi ships every few days, so behind a 7-day hold `pi update` fails almost every time, and pi's startup
notice keeps advertising a release you can't install.

## What this package does

- **`pi update` and `/update` install the newest release your registry can serve.** They walk back
  from the latest release, checking which versions the registry lists and that every package each
  one needs is downloadable, and hand that version to pi's own updater. Nothing bypasses your
  registry; pi installs exactly as it normally does.
- **The startup notice tells the truth.** "New version X is available" names the release `pi update`
  will actually install, and a note says when newer ones should become installable (publish time
  plus your registry's hold period).

```
 Update Available
 New version 1.1.0 is available. Run pi update

 Your npm registry (packagefeedproxy.microsoft.io) holds new packages for about 7 days,
 so `pi update` can't install this yet.

 Next installable: pi 1.0.0 around Thu, Oct 8, 3:15 PM (in 9h); latest pi 1.1.0
 around Wed, Oct 14, 6:16 PM (in 6d 12h).
```

```
$ pi update
pi 1.1.0 can't be installed from your npm registry (packagefeedproxy.microsoft.io): the registry doesn't list it yet (it holds new packages for about 7 days).
Updating to pi 0.99.2 instead, the newest release your registry can install.
Updating managed pi installation...
Updated pi from 0.99.0 to 0.99.2
```

If your registry can serve the latest release, nothing changes: pi behaves exactly as it does
without this package.

## Install

```bash
pi install git:github.com/<org>/pi-registry-update@v1.0.0
```

Restart pi. If you installed pi with the pi.dev installer, also run this once inside pi so that
`pi update` typed in a shell gets the fallback too:

```
/registry-update install-hook
```

To check that everything is wired up, run `/registry-update`.

## Commands

| Command | What it does |
|---|---|
| `/update [args]` | Runs `pi update [args]` with the registry fallback. Restart pi afterwards. |
| `/registry-update` | Status: running vs. latest vs. installable release, ETAs, settings, hook state. |
| `/registry-update install-hook` | Makes `pi update` in a shell use the fallback (pi.dev-installer installs only). |
| `/registry-update uninstall-hook` | Removes that hook. |
| `/registry-update update [args]` | Same as `/update`, in case another extension owns `/update`. |

The hook is also available from a shell: `node <package dir>/lib/hook.mjs [status|install|uninstall]`.

### Why the hook

pi doesn't load extensions for `pi update`, so the shell command can only be reached through pi's
launcher (`~/.pi/agent/bin/pi-launcher.js`, created by the pi.dev installer). The hook is a marked
block of a few lines plus one changed argument list:

- it is applied only if the launcher has the expected shape, and syntax-checked before it's written;
- it is idempotent, and `uninstall-hook` restores the launcher byte for byte;
- if this package is removed, the hook finds nothing to load and does nothing;
- re-running the pi.dev installer replaces the launcher. pi then warns at startup, and
  `/registry-update install-hook` puts the hook back.

## Settings

Optional file: `~/.pi/agent/registry-update.json`

```json
{
	"registryCooldownDays": 7,
	"publishTimesRegistry": "https://registry.npmjs.org/"
}
```

- **`registryCooldownDays`** (default `7`): how long your registry holds new packages. Only the ETAs
  use it; which release gets installed is decided by what the registry actually serves. If a notice
  says a release is "due now; the registry hasn't listed it yet", the value is too low.
  `PI_REGISTRY_UPDATE_DEBUG=1 pi update` prints the hold implied by what the registry currently lists.
- **`publishTimesRegistry`**: where release dates come from. A registry with a hold only lists the
  releases that already cleared it, so dates for the others come from the public npm registry by
  default. This reads package metadata only; nothing is installed from it. Set it to `null` to turn
  ETAs off.

Environment variables:

| Variable | Effect |
|---|---|
| `PI_REGISTRY_UPDATE=0` | Disable everything for one run (stock pi behaviour). |
| `PI_REGISTRY_UPDATE_COOLDOWN_DAYS` | Override `registryCooldownDays`. |
| `PI_REGISTRY_UPDATE_DEBUG=1` | Show the planning: on stderr for `pi update`, in `%TEMP%/pi-registry-update.log` (`$TMPDIR` elsewhere) for the startup notice. |

## How it works

pi has no extension point for choosing which release to update to. This package intercepts pi's
request for `https://pi.dev/api/latest-version` (a global `fetch` call) and answers with the newest
release your registry can serve; pi's own updater does the rest. For the notice that happens inside
the interactive pi process; for `pi update` a small preload (`lib/preload.mjs`) is loaded into the
update process by the launcher hook or by `/update`.

To pick the release it:

1. asks your registry which pi versions it lists (`npm view`, run from pi's install directory so a
   project `.npmrc` in your working directory doesn't apply, just as for pi's own `npm ci`);
2. walks back from the latest release, downloading each candidate's installer lockfile from pi.dev
   and probing every tarball it needs on your registry (1-byte range requests), and picks the first
   candidate that is complete.

Network access: pi.dev (as pi itself), your npm registry, and `publishTimesRegistry` (metadata only).
npm settings and release dates are cached in `%TEMP%/pi-registry-update-cache.json` (`$TMPDIR`
elsewhere): npm settings for a day or until your `.npmrc` changes, release dates until a new release
appears.

Fail-safe: any error, or a future pi version that stops making that request, leaves pi's answer
untouched, so pi behaves exactly as it does without this package.

## Compatibility

Tested with pi 0.99.x (pi.dev installer, Windows, Node 24) and against pi 1.1.0's update code.
`/update` should also work for npm-global installs, because pi's npm self-update uses the same
version answer; that path is untested. The shell hook needs a pi.dev-installer install.

## Uninstall

```
/registry-update uninstall-hook
```

```bash
pi remove git:github.com/<org>/pi-registry-update
```

Optionally delete `~/.pi/agent/registry-update.json` and the cache file.

## Development

Load a working copy without installing it:

```bash
pi -e ./extensions/registry-update.ts
```

Without a terminal, RPC mode exercises the commands end to end:

```bash
pi --mode rpc --no-session --no-extensions -e ./extensions/registry-update.ts
{"id":"1","type":"prompt","message":"/registry-update status"}
```
