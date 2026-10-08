/**
 * pi-registry-update
 *
 * For npm registries that hold back newly published packages (minimum release age / cooldown
 * policies, e.g. a corporate proxy): `pi update` installs the newest pi release the registry can
 * serve instead of failing, and pi's update notice says when newer releases become installable.
 * Nothing bypasses the registry. See README.md.
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
// Plain ESM helpers without type declarations, shared with the `pi update` preload.
// @ts-ignore
import { etaSentence, formatDays, getStatus, installFetchHook } from "../lib/core.mjs";
// @ts-ignore
import { describeHook, hookStatus, installHook, PRELOAD_PATH, uninstallHook } from "../lib/hook.mjs";

const SUBCOMMANDS = "status | update [args] | install-hook | uninstall-hook";
const STATUS_KEY = "registry-update";
let startupChecked = false;

export default function registryUpdate(pi: ExtensionAPI) {
	// Inert until pi asks pi.dev for the latest version (the interactive startup update check).
	installFetchHook("notice");

	pi.registerCommand("update", {
		description: "Update pi to the newest release your npm registry can install",
		handler: async (args, ctx) => runUpdate(args, ctx),
	});

	pi.registerCommand("registry-update", {
		description: `Registry-aware pi updates: ${SUBCOMMANDS}`,
		handler: async (args, ctx) => {
			const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (sub === "status") return showStatus(ctx);
			if (sub === "update") return runUpdate(rest.join(" "), ctx);
			if (sub === "install-hook") return report(ctx, installHook());
			if (sub === "uninstall-hook") return report(ctx, uninstallHook());
			ctx.ui.notify(`Usage: /registry-update ${SUBCOMMANDS}`, "warning");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (startupChecked || ctx.mode !== "tui") return;
		startupChecked = true;
		try {
			const hook = hookStatus();
			if (hook.lost) {
				ctx.ui.notify(
					"pi-registry-update: pi's installer replaced its launcher, so `pi update` in a shell no longer falls back to what your npm registry can serve. Run /registry-update install-hook to restore it.",
					"warning",
				);
			} else if (hook.installed && !hook.current) {
				ctx.ui.notify("pi-registry-update: the `pi update` hook points at another copy of this package. Run /registry-update install-hook to update it.", "warning");
			}
		} catch {
			// a status check must never disturb startup
		}
	});
}

/** Runs `pi update [args]` in a child process with the registry-aware preload and relays its output. */
async function runUpdate(args: string, ctx: ExtensionCommandContext) {
	const cli = process.argv[1];
	if (!cli || !existsSync(cli)) {
		ctx.ui.notify("pi-registry-update: can't find pi's CLI script to run the update.", "error");
		return;
	}
	const extra = args.trim() ? args.trim().split(/\s+/) : [];
	ctx.ui.setStatus(STATUS_KEY, "updating pi…");
	let output = "";
	const relay = (kind: "info" | "warning") => {
		let partial = "";
		const emit = (line: string) => {
			const text = line.trim();
			if (text && !text.startsWith("npm notice")) ctx.ui.notify(text, kind);
		};
		return {
			push(chunk: Buffer) {
				output += chunk.toString();
				const lines = (partial + chunk.toString()).split(/\r?\n/);
				partial = lines.pop() ?? "";
				lines.forEach(emit);
			},
			flush() {
				emit(partial);
				partial = "";
			},
		};
	};
	const out = relay("info");
	const err = relay("warning");
	const code = await new Promise<number | null>((resolve) => {
		const child = spawn(process.execPath, ["--import", pathToFileURL(PRELOAD_PATH).href, cli, "update", ...extra], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", (error) => {
			output += String(error);
			resolve(null);
		});
		child.on("close", (exitCode) => resolve(exitCode));
	});
	out.flush();
	err.flush();
	ctx.ui.setStatus(STATUS_KEY, undefined);
	const updated = /Updated \S+ from (\S+) to (\S+)/.exec(output);
	if (code !== 0) ctx.ui.notify(`pi update failed${code === null ? "" : ` (exit code ${code})`}.`, "error");
	else if (updated) ctx.ui.notify(`Restart pi to start using ${updated[2]}.`, "warning");
}

async function showStatus(ctx: ExtensionCommandContext) {
	ctx.ui.setStatus(STATUS_KEY, "checking…");
	try {
		const s = await getStatus();
		const host = hostOf(s.registry);
		const lines = ["pi-registry-update"];
		if (!s.latest) {
			lines.push(`  running pi ${s.current}; pi.dev didn't report a latest release`);
		} else if (s.installable === s.latest) {
			lines.push(`  running pi ${s.current}; pi ${s.latest} is installable from ${host}: run /update`);
		} else if (s.installable) {
			lines.push(`  running pi ${s.current}; pi ${s.installable} is installable from ${host} (run /update), ${s.latest} is held back`);
		} else if (s.pending.length > 0 || s.latest !== s.current) {
			lines.push(`  running pi ${s.current}; latest ${s.latest} isn't installable from ${host} yet`);
		} else {
			lines.push(`  running pi ${s.current}, the latest release`);
		}
		const eta = etaSentence(s.pending, s.latest, { label: s.installable ? "Next after that" : "Next installable" });
		if (eta) lines.push(`  ${eta}`);
		lines.push(
			`  registry hold: ${formatDays(s.config.cooldownDays)} (registryCooldownDays in ${s.config.path}${s.config.exists ? "" : ", not created yet"})`,
		);
		lines.push(
			s.config.publishTimesRegistry
				? `  release dates from ${hostOf(s.config.publishTimesRegistry)} (metadata only)`
				: "  ETAs off (publishTimesRegistry is null)",
		);
		lines.push(`  ${describeHook(hookStatus())}`);
		ctx.ui.notify(lines.join("\n"), "info");
	} catch (error) {
		ctx.ui.notify(`pi-registry-update: status check failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	} finally {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function report(ctx: ExtensionCommandContext, result: { ok: boolean; message: string }) {
	ctx.ui.notify(result.message, result.ok ? "info" : "error");
}

function hostOf(url: string) {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}
