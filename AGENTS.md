# AGENTS.md

This repo is a pi extension for npm registries that hold back newly published packages. When the newest pi release isn't available from your registry yet, `pi update` installs the newest one that is. It is published to npm as [`@duncanbeard/pi-registry-update`](https://www.npmjs.com/package/@duncanbeard/pi-registry-update), and the source lives at [`DuncanBeard/pi-registry-update`](https://github.com/DuncanBeard/pi-registry-update). On this machine the working copy is at `C:\Users\duncanbeard\Source\Repos\pi-registry-update`, which WSL sees as `/mnt/c/Users/duncanbeard/Source/Repos/pi-registry-update`.

## Layout

- `extensions/registry-update.ts` is the pi entry point. It provides the `/update` and `/registry-update` commands, plus a startup check of the hook.
- `lib/core.mjs` holds the shared logic: the `fetch` hook that answers pi's latest-version request, version planning, release-date estimates, and the cache.
- `lib/hook.mjs` adds and removes the opt-in hook in pi's launcher.
- `lib/preload.mjs` is the preload that the launcher hook and `/update` load into `pi update`.
- `README.md` holds the user docs, which appear on npm and the pi.dev gallery. `package.json` is the npm and pi manifest.
- `AGENTS.md` is this file. It is not published, because the `files` list in `package.json` leaves it out.

## Git identity (required)

- Commit and push **only** as the personal GitHub account `DuncanBeard`. Never use `duncanbeard_microsoft`, and never use an `@microsoft.com` email.
- Windows git's global identity on this machine is the Microsoft one. This repo's local config overrides it for both Windows git and WSL git, so it must stay set. On a fresh clone, set it again:
  ```bash
  git config user.name "Duncan Beard"
  git config user.email "5641626+DuncanBeard@users.noreply.github.com"
  ```
  Before every commit, `git config user.email` must print the noreply address above.
- Git Credential Manager stores both GitHub accounts. The remote URL includes `DuncanBeard@` so that GCM always picks the personal one. Keep it that way:
  ```bash
  git remote set-url origin https://DuncanBeard@github.com/DuncanBeard/pi-registry-update.git
  ```
- After pushing, check that GitHub credits the commit to `DuncanBeard`. Both lines should show it:
  ```bash
  curl -s https://api.github.com/repos/DuncanBeard/pi-registry-update/commits/main | grep -m2 '"login"'
  ```

## Package rules

- Keep `pi-package` in `keywords`. The pi.dev gallery lists packages based on that keyword.
- Packages that pi provides (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) belong in `peerDependencies` with the range `"*"`. Never put them in `dependencies`. The code otherwise uses only Node built-ins; keep it that way unless there is a strong reason.
- `files` lists exactly what gets published: `extensions`, `lib`, `README.md`, `LICENSE`. After adding files, run `npm pack --dry-run` to check the result.
- This repo is public. Keep code, docs and examples free of employer-internal hostnames, feed names and other internal details. Use `npm-proxy.example.com` in examples.

## Test

Load check, which doesn't call a model. Don't use `pi --help` for this, because it doesn't report extension load errors. Both `"name":"update"` and `"name":"registry-update"` should appear:

```bash
{ printf '{"id":"1","type":"get_commands"}\n'; sleep 8; } \
  | pi --mode rpc --no-session -ne -ns -np --offline -e . 2>/tmp/rpc.err \
  | grep -m1 '"command":"get_commands"' | grep -o '"name":"[a-z-]*update"' \
  || cat /tmp/rpc.err
```

Status check. It only reads data: it fetches from pi.dev, runs `npm view` against the registry, and writes a cache file to the temp directory.

```bash
{ printf '{"id":"1","type":"prompt","message":"/registry-update status"}\n'; sleep 30; } \
  | pi --mode rpc --no-session -ne -ns -np -e . 2>/dev/null \
  | grep -m1 '"method":"notify"' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).message))'
```

Never run these as tests unless the user asks:

- `/update` and `/registry-update update` update pi itself.
- `/registry-update install-hook` and `uninstall-hook` rewrite pi's launcher.

Set `PI_REGISTRY_UPDATE_DEBUG=1` to see the planning output (see the README).

## Release

1. Commit your changes using the identity above. The working tree must be clean.
2. Bump the version. This commits and tags `vX.Y.Z` using this repo's identity.
   ```bash
   npm version patch   # or minor / major
   git push --follow-tags
   ```
3. Publish. `npm whoami` must print `duncanbeard`. If it doesn't, log in. In an agent shell, run the login in the background and give the user the `Login at:` URL from the log:
   ```bash
   setsid nohup npm login --auth-type=web > /tmp/npm-login.log 2>&1 < /dev/null &
   ```
   The npm account has 2FA turned on. In a real terminal, `npm publish` prints a link to approve in the browser. In an agent shell there is no terminal, so a plain `npm publish` fails with `EOTP`. Run it in a pseudo-terminal in the background and give the user the approval link:
   ```bash
   setsid nohup bash -c 'exec 3< <(sleep 900); script -qfec "npm publish" /dev/null <&3; kill $! 2>/dev/null' \
     > /tmp/npm-publish.log 2>&1 < /dev/null &
   sleep 15; grep -a -A1 "Authenticate your account" /tmp/npm-publish.log
   ```
   Once the user approves, `+ @duncanbeard/pi-registry-update@X.Y.Z` appears in the log and the wrapper exits by itself. Another option is to ask the user for a current 6-digit code and immediately run `npm publish --otp=<code>`.
4. Confirm the release. A new version can take a few minutes to show up. A `0.0.0-stage` version also appears in the list; npm creates it during publishing and it is normal.
   ```bash
   npm view @duncanbeard/pi-registry-update dist-tags
   ```
   For a full check, rerun the load check with `-e npm:@duncanbeard/pi-registry-update` in place of `-e .`, and drop `--offline` so pi can download the package.

Changes that only touch `AGENTS.md` don't need a release, because the file isn't published.

## This machine

- The Windows pi loads this package straight from the working copy: its `settings.json` lists the path `..\..\source\Repos\pi-registry-update`. Its launcher hook also points at this working copy's `lib/preload.mjs`. Edits here therefore take effect in the Windows pi when it restarts, and a broken `lib/` affects its `pi update`.
- The Windows npm registry holds new packages for about 7 days. A freshly published version can't be installed there until the hold expires, so keep the working-copy install until then. When switching that pi to the npm package, remove the local path from its `settings.json` and run `/registry-update install-hook` again so the hook points at the installed copy.
- The launcher hook only works with Windows installs from the pi.dev installer, which have `pi-launcher.js`. On Linux the installer's launcher is a shell script, so the hook reports itself as not applicable, although its message names the wrong path. `/update` inside pi works on both.
