// Opt-in hook in pi's launcher so `pi update` typed in a shell gets the registry-aware behaviour.
// pi doesn't load extensions for `pi update`, so its launcher is the only way in. Only installs made
// by the pi.dev installer ("managed" installs) have one: <agent dir>/bin/pi-launcher.js. For other
// installs, use /update inside pi.
//
// The edit is a marked block plus one changed argument list. It is applied only if the launcher has
// the expected shape, syntax-checked before it replaces the file, idempotent, and reversible. If this
// package is removed, the hook finds no preload and does nothing.
//
// CLI: node lib/hook.mjs [status|install|uninstall]

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir } from "./core.mjs";

const BEGIN = "// >>> pi-registry-update hook";
const END = "// <<< pi-registry-update hook";
const STOCK_SPAWN = "spawnSync(process.execPath, [cliPath,";
const HOOKED_SPAWN = "spawnSync(process.execPath, [...piRegistryUpdateArgs(), cliPath,";
const SPAWN_RE = /spawnSync\(process\.execPath,\s*\[cliPath,/;
const SPAWN_RE_ALL = new RegExp(SPAWN_RE.source, "g");
export const PRELOAD_PATH = fileURLToPath(new URL("./preload.mjs", import.meta.url));

/** Locates the launcher of a pi.dev-installer ("managed") install. */
export function findLauncher() {
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT || join(agentDir(), "install");
	const markerPath = join(installRoot, "managed-install.json");
	if (!existsSync(markerPath)) {
		return { reason: "pi wasn't installed with the pi.dev installer, so there's no launcher to hook; use /update inside pi" };
	}
	let marker;
	try {
		marker = JSON.parse(readFileSync(markerPath, "utf8"));
	} catch {
		return { reason: `can't read ${markerPath}` };
	}
	if (marker?.kind !== "pi-managed-install") return { reason: `unrecognized ${markerPath}` };
	const entrypoint = typeof marker.entrypoint?.path === "string" ? marker.entrypoint.path : undefined;
	const launcher = join(entrypoint ? dirname(entrypoint) : join(dirname(installRoot), "bin"), "pi-launcher.js");
	if (!existsSync(launcher)) return { reason: `pi's launcher isn't at ${launcher}` };
	return { launcher, backup: `${launcher}.pi-registry-update.bak` };
}

export function hookStatus() {
	const found = findLauncher();
	if (!found.launcher) return { applicable: false, installed: false, reason: found.reason };
	const text = readFileSync(found.launcher, "utf8");
	const installed = text.includes(BEGIN) && text.includes(HOOKED_SPAWN);
	return {
		applicable: true,
		installed,
		current: installed && text.includes(JSON.stringify(PRELOAD_PATH)), // points at this copy of the package
		launcher: found.launcher,
		lost: !installed && existsSync(found.backup), // installed before, then pi's installer rewrote the launcher
	};
}

export function describeHook(status) {
	if (!status.applicable) return `\`pi update\` hook: not applicable (${status.reason}).`;
	if (status.installed) {
		return status.current
			? `\`pi update\` hook: installed in ${status.launcher}.`
			: "`pi update` hook: points at another copy of pi-registry-update; run /registry-update install-hook to update it.";
	}
	if (status.lost) return "`pi update` hook: missing (pi's installer replaced the launcher); run /registry-update install-hook.";
	return "`pi update` hook: not installed; /registry-update install-hook makes `pi update` in a shell use the fallback.";
}

export function installHook() {
	const found = findLauncher();
	if (!found.launcher) return { ok: false, message: found.reason };
	const original = readFileSync(found.launcher, "utf8");
	const stock = unhook(original);
	if ((stock.match(SPAWN_RE_ALL) ?? []).length !== 1) {
		return { ok: false, message: `${found.launcher} doesn't have the expected shape; left it unchanged.` };
	}
	const eol = /\r\n/.test(stock) && !/[^\r]\n/.test(stock) ? "\r\n" : "\n";
	const block = [
		`${BEGIN}: \`pi update\` falls back to the newest pi release your npm registry can serve.`,
		"// Added by the pi-registry-update package; /registry-update uninstall-hook removes it.",
		"function piRegistryUpdateArgs() {",
		`\tconst preload = ${JSON.stringify(PRELOAD_PATH)};`,
		'\tif (process.argv[2] !== "update" || process.env.PI_REGISTRY_UPDATE === "0" || !require("node:fs").existsSync(preload)) return [];',
		'\treturn ["--import", require("node:url").pathToFileURL(preload).href];',
		"}",
		END,
		"",
	].join(eol);
	const lineStart = stock.lastIndexOf("\n", stock.search(SPAWN_RE)) + 1;
	const hooked = stock.slice(0, lineStart) + block + stock.slice(lineStart).replace(SPAWN_RE, HOOKED_SPAWN);
	if (hooked === original) return { ok: true, changed: false, message: `Already installed in ${found.launcher}.` };
	if (!original.includes(BEGIN)) copyFileSync(found.launcher, found.backup); // pristine copy, refreshed after a pi reinstall
	writeChecked(found.launcher, hooked);
	return {
		ok: true,
		changed: true,
		message: `Installed in ${found.launcher}: \`pi update\` now falls back to the newest release your npm registry can serve.`,
	};
}

export function uninstallHook() {
	const found = findLauncher();
	if (!found.launcher) return { ok: false, message: found.reason };
	const original = readFileSync(found.launcher, "utf8");
	const stock = unhook(original);
	if (stock !== original) writeChecked(found.launcher, stock);
	rmSync(found.backup, { force: true });
	return {
		ok: true,
		changed: stock !== original,
		message: stock !== original ? `Removed from ${found.launcher}.` : "The `pi update` hook wasn't installed.",
	};
}

function unhook(text) {
	let result = text;
	const begin = result.indexOf(BEGIN);
	const end = begin >= 0 ? result.indexOf(END, begin) : -1;
	if (begin >= 0 && end >= 0) {
		const lineStart = result.lastIndexOf("\n", begin) + 1;
		const lineEnd = result.indexOf("\n", end);
		result = result.slice(0, lineStart) + result.slice(lineEnd < 0 ? result.length : lineEnd + 1);
	}
	return result.replace(HOOKED_SPAWN, STOCK_SPAWN);
}

/** Replaces `target` via a temporary file that must pass `node --check` first. */
function writeChecked(target, content) {
	const temporary = join(dirname(target), `pi-launcher.pi-registry-update-${process.pid}.js`);
	writeFileSync(temporary, content);
	try {
		const check = spawnSync(process.execPath, ["--check", temporary], { encoding: "utf8" });
		if (check.status !== 0) {
			throw new Error(`the edited launcher failed a syntax check: ${(check.stderr || "").trim().split(/\r?\n/)[0]}`);
		}
		renameSync(temporary, target);
	} finally {
		rmSync(temporary, { force: true });
	}
}

const self = fileURLToPath(import.meta.url);
const invoked = process.argv[1] ? resolve(process.argv[1]) : "";
if (process.platform === "win32" ? invoked.toLowerCase() === self.toLowerCase() : invoked === self) {
	const command = process.argv[2] ?? "status";
	const result =
		command === "install"
			? installHook()
			: command === "uninstall"
				? uninstallHook()
				: command === "status"
					? { ok: true, message: describeHook(hookStatus()) }
					: { ok: false, message: "usage: node lib/hook.mjs [status|install|uninstall]" };
	console.log(result.message);
	process.exitCode = result.ok ? 0 : 1;
}
