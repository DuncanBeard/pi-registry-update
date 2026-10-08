// Shared logic for pi-registry-update. Two entry points use it:
//  - extensions/registry-update.ts, in-process in interactive pi: the startup update notice and
//    /registry-update status (installFetchHook("notice"));
//  - lib/preload.mjs, loaded with `node --import` into `pi update` processes started by the launcher
//    hook or by /update (installFetchHook("update")).
//
// pi has no hook for choosing which release it updates to, so this intercepts pi's request for
// https://pi.dev/api/latest-version (a global fetch call) and answers with the newest release the
// configured npm registry can serve. pi's own updater then installs that release as usual: same npm,
// same registry, nothing bypassed. Any error leaves pi's answer untouched, i.e. stock behaviour.

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_INSTALLER_API_BASE = "https://pi.dev/api/installer/releases";
const DEFAULT_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
const DEFAULT_PUBLISH_TIMES_REGISTRY = "https://registry.npmjs.org/";
const DEFAULT_COOLDOWN_DAYS = 7;
const FIRST_PARTY_SCOPE = "@earendil-works/";
const PACKAGE_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const STABLE_VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;
const MAX_CANDIDATES = 6;
const PROBE_CONCURRENCY = 16;
const REQUEST_TIMEOUT_MS = 20_000;
const NPM_TIMEOUT_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const NPM_CONFIG_TTL_MS = DAY_MS;
const HOOK_STATE = Symbol.for("pi-registry-update.fetch-hook");

export const CONFIG_PATH = join(agentDir(), "registry-update.json");
export const CACHE_PATH = join(tmpdir(), "pi-registry-update-cache.json");
export const LOG_PATH = join(tmpdir(), "pi-registry-update.log");

const DEBUG = process.env.PI_REGISTRY_UPDATE_DEBUG === "1";
const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
	weekday: "short",
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});

/** "update": messages go to stderr (`pi update`). "notice": never write to the terminal (TUI). */
let mode = "notice";

/** pi's agent directory: PI_CODING_AGENT_DIR or ~/.pi/agent, like pi's getAgentDir(). */
export function agentDir() {
	const fromEnv = process.env.PI_CODING_AGENT_DIR;
	if (!fromEnv) return join(homedir(), ".pi", "agent");
	if (fromEnv === "~") return homedir();
	return /^~[\\/]/.test(fromEnv) ? join(homedir(), fromEnv.slice(2)) : fromEnv;
}

// ---------------------------------------------------------------------------------------------
// The fetch hook.

/** Wraps globalThis.fetch so pi's latest-version request gets a registry-aware answer. Idempotent. */
export function installFetchHook(hookMode) {
	if (process.env.PI_REGISTRY_UPDATE === "0" || typeof globalThis.fetch !== "function" || globalThis[HOOK_STATE]) {
		return false;
	}
	mode = hookMode;
	// pi's http-dispatcher calls undici.install(), which *assigns* globalThis.fetch. An accessor keeps
	// this wrapper visible and adopts whatever gets assigned as the inner implementation, so every other
	// request still goes through pi's own fetch/dispatcher unchanged.
	const state = { inner: globalThis.fetch, decision: undefined };
	const realFetch = (input, init) => state.inner(input, init);

	const wrapper = async function fetch(input, init) {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
		if (typeof url !== "string" || !url.startsWith(LATEST_VERSION_URL)) return state.inner(input, init);

		const response = await state.inner(input, init);
		if (!response.ok) return response;
		const body = await response.text(); // read now: pi's request timeout also covers the body
		const reply = (text) =>
			new Response(text, {
				status: response.status,
				statusText: response.statusText,
				headers: { "content-type": "application/json" },
			});
		try {
			state.decision ??= (mode === "update" ? planUpdate : planNotice)(JSON.parse(body), realFetch);
			const replacement = await state.decision;
			return reply(replacement ? JSON.stringify(replacement) : body);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (mode === "update") say(`pi-registry-update skipped (${message}); using pi's default update.`);
			else debug(`notice: skipped (${message})`);
			return reply(body);
		}
	};

	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
	Object.defineProperty(globalThis, "fetch", {
		configurable: true,
		enumerable: descriptor?.enumerable ?? true,
		get: () => wrapper,
		set: (value) => {
			if (typeof value === "function" && value !== wrapper) state.inner = value;
		},
	});
	Object.defineProperty(globalThis, HOOK_STATE, { value: state, configurable: true });
	return true;
}

/** fetch without the latest-version rewrite. */
function rawFetch() {
	const state = globalThis[HOOK_STATE];
	return state ? (input, init) => state.inner(input, init) : (input, init) => globalThis.fetch(input, init);
}

// ---------------------------------------------------------------------------------------------
// `pi update`: choose the newest release that installs cleanly from the registry.

async function planUpdate(data, realFetch) {
	const release = releaseInfo(data);
	if (!release) return undefined;
	const { latest, current, packageName } = release;
	const config = loadConfig();
	const [npmConfig, versionsJson] = await Promise.all([
		npmRegistryConfig({ fresh: true }),
		runNpm(["view", packageName, "versions", "--json"]),
	]);
	const registryHost = new URL(npmConfig.registry).host;
	const offered = new Set([].concat(JSON.parse(versionsJson)).filter((v) => typeof v === "string"));
	const candidates = newerThan([...offered], current, latest).slice(0, MAX_CANDIDATES);
	debug(`latest=${latest} running=${current} registry=${npmConfig.registry} offers ${offered.size} versions; candidates: ${candidates.join(", ") || "(none)"}`);

	let target;
	const skipped = [];
	for (const version of candidates) {
		const probe = await probeRelease(version, npmConfig, realFetch);
		debug(`probe ${version}: ${JSON.stringify(probe)}`);
		if (probe.ok) {
			target = version;
			break;
		}
		skipped.push({ version, reason: probe.reason });
	}
	if (target === latest) return undefined; // latest installs fine: stock behaviour

	const latestSkip = skipped.find((s) => s.version === latest);
	const why = latestSkip
		? latestSkip.reason
		: `the registry doesn't list it yet (it holds new packages for about ${formatDays(config.cooldownDays)})`;
	say(`pi ${latest} can't be installed from your npm registry (${registryHost}): ${why}.`);
	for (const s of skipped) if (s.version !== latest) say(`  skipped pi ${s.version}: ${s.reason}`);
	say(
		target
			? `Updating to pi ${target} instead, the newest release your registry can install.`
			: `No newer release is installable from it yet; staying on pi ${current}.`,
	);
	const times = await publishTimes(packageName, latest, config, realFetch).catch((error) => {
		debug(`publish times unavailable: ${error.message}`);
		return undefined;
	});
	const pending = pendingReleases(times, target ?? current, latest, config);
	const eta = etaSentence(pending, latest, { label: target ? "Next after that" : "Next installable" });
	if (eta) say(eta);
	debugCalibration(times, offered, config);
	return withVersion(data, target ?? current);
}

/** Checks that every tarball in the release's installer lockfile is downloadable from the registry. */
async function probeRelease(version, npmConfig, realFetch) {
	const base = (process.env.PI_INSTALLER_API_BASE?.trim() || DEFAULT_INSTALLER_API_BASE).replace(/\/+$/, "");
	const lockResponse = await realFetch(`${base}/${encodeURIComponent(version)}/package-lock.json`, {
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (lockResponse.status === 404) return { ok: false, reason: "pi.dev has no installer lockfile for it" };
	if (!lockResponse.ok) throw new Error(`installer lockfile for ${version}: HTTP ${lockResponse.status}`);
	const lock = await lockResponse.json();

	const tarballs = new Map();
	for (const [key, entry] of Object.entries(lock.packages ?? {})) {
		if (!key || typeof entry?.resolved !== "string" || !/^https?:\/\//i.test(entry.resolved)) continue;
		const name = key.slice(key.lastIndexOf("node_modules/") + "node_modules/".length);
		const url = toRegistryUrl(entry.resolved, npmConfig);
		if (!tarballs.has(url)) tarballs.set(url, { spec: `${name}@${entry.version}`, firstParty: name.startsWith(FIRST_PARTY_SCOPE) });
	}
	// pi's own packages first: they're what a fresh release is most likely missing.
	const queue = [...tarballs].sort(([, a], [, b]) => Number(b.firstParty) - Number(a.firstParty));
	const stop = new AbortController();
	let missing;
	let unverified = 0;
	const worker = async () => {
		while (!missing && queue.length > 0) {
			const [url, { spec }] = queue.shift();
			try {
				const res = await realFetch(url, {
					headers: { range: "bytes=0-0" },
					signal: AbortSignal.any([stop.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
				});
				res.body?.cancel().catch(() => {});
				if (res.status === 404 || res.status === 410) {
					missing ??= spec;
					stop.abort();
				} else if (!res.ok) {
					unverified++; // e.g. 401 on an authenticated feed: leave the verdict to npm ci
				}
			} catch {
				if (!missing) unverified++;
			}
		}
	};
	await Promise.all(Array.from({ length: PROBE_CONCURRENCY }, worker));
	return missing
		? { ok: false, reason: `${missing} isn't available from it` }
		: { ok: true, checked: tarballs.size, unverified };
}

/** Mirrors how `npm ci` rewrites lockfile `resolved` URLs (replace-registry-host). */
function toRegistryUrl(resolved, { registry, replaceRegistryHost }) {
	const hostMode = replaceRegistryHost || "npmjs";
	if (hostMode === "never") return resolved;
	const url = new URL(resolved);
	const matchHost =
		hostMode === "npmjs" ? "registry.npmjs.org" : hostMode.includes("://") ? new URL(hostMode).hostname : hostMode;
	if (hostMode !== "always" && url.hostname !== matchHost) return resolved;
	const reg = new URL(registry);
	url.protocol = reg.protocol;
	url.hostname = reg.hostname;
	url.port = reg.port;
	const regPath = reg.pathname.replace(/\/$/, "");
	if (regPath && url.pathname !== regPath && !url.pathname.startsWith(`${regPath}/`)) url.pathname = regPath + url.pathname;
	return url.href;
}

// ---------------------------------------------------------------------------------------------
// Startup notice: name the newest installable release and give ETAs for the held-back ones.

async function planNotice(data, realFetch) {
	const release = releaseInfo(data);
	if (!release) return undefined;
	const { latest, current, packageName } = release;
	const config = loadConfig();
	const npmConfig = await npmRegistryConfig({ fresh: false });
	const offered = await registryVersions(packageName, npmConfig, realFetch);
	const installable = newerThan(offered, current, latest)[0];
	debug(`notice: latest=${latest} running=${current} installable=${installable ?? "none"}`);
	if (installable === latest) return undefined; // stock notice is accurate

	const registryHost = new URL(npmConfig.registry).host;
	const held = `your npm registry (${registryHost}) holds new packages for about ${formatDays(config.cooldownDays)}`;
	const times = await publishTimes(packageName, latest, config, realFetch).catch((error) => {
		debug(`notice: publish times unavailable (${error.message})`);
		return undefined;
	});
	const pending = pendingReleases(times, installable ?? current, latest, config);
	const eta = etaSentence(pending, latest, {
		label: installable ? "Next after that" : "Next installable",
		markdown: true,
	});
	if (installable) {
		const note = `pi ${latest} is out too, but ${held}.${eta ? `\n\n${eta}` : ""}`;
		return { ...withVersion(data, installable), note };
	}
	const note = `${capitalize(held)}, so \`pi update\` can't install this yet.${eta ? `\n\n${eta}` : ""}`;
	return { ...data, note: data.note ? `${data.note}\n\n${note}` : note };
}

/** Versions the registry lists; direct (anonymous) packument fetch, else `npm view` (handles auth). */
async function registryVersions(packageName, npmConfig, fetchFn) {
	try {
		const url = new URL(packageName.replace("/", "%2f"), withTrailingSlash(npmConfig.registry)).href;
		const res = await fetchFn(url, {
			headers: { accept: "application/vnd.npm.install-v1+json" },
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (res.ok) return Object.keys((await res.json()).versions ?? {});
		debug(`packument HTTP ${res.status}; falling back to npm view`);
	} catch (error) {
		debug(`packument fetch failed (${error.message}); falling back to npm view`);
	}
	return [].concat(JSON.parse(await runNpm(["view", packageName, "versions", "--json"]))).filter((v) => typeof v === "string");
}

// ---------------------------------------------------------------------------------------------
// Status snapshot for /registry-update status.

export async function getStatus() {
	const fetchFn = rawFetch();
	const config = loadConfig();
	const current = runningPiVersion();
	const res = await fetchFn(LATEST_VERSION_URL, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`pi.dev latest-version: HTTP ${res.status}`);
	const data = await res.json();
	const latest = typeof data.version === "string" ? data.version.trim() : "";
	const packageName = packageNameOf(data);
	const npmConfig = await npmRegistryConfig({ fresh: false });
	const status = { config, current, latest, registry: npmConfig.registry, installable: undefined, pending: [] };
	if (!isStable(latest) || !isStable(current) || compareVersions(latest, current) <= 0) return status;
	status.installable = newerThan(await registryVersions(packageName, npmConfig, fetchFn), current, latest)[0];
	if (status.installable !== latest) {
		const times = await publishTimes(packageName, latest, config, fetchFn).catch(() => undefined);
		status.pending = pendingReleases(times, status.installable ?? current, latest, config);
	}
	return status;
}

// ---------------------------------------------------------------------------------------------
// ETAs: publish time (metadata from publishTimesRegistry) + registryCooldownDays.

/** Publish times by version, cached until pi.dev reports a release the cache doesn't know. */
async function publishTimes(packageName, latest, config, fetchFn) {
	if (!config.publishTimesRegistry) return undefined;
	const key = `${config.publishTimesRegistry}|${packageName}`;
	const cached = readCache().publishTimes?.[key];
	if (cached?.times?.[latest]) return cached.times;
	const url = new URL(packageName.replace("/", "%2f"), withTrailingSlash(config.publishTimesRegistry)).href;
	const res = await fetchFn(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
	if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
	const times = {};
	for (const [version, time] of Object.entries((await res.json()).time ?? {})) {
		if (isStable(version) && typeof time === "string") times[version] = time;
	}
	updateCache((cache) => ({ ...cache, publishTimes: { ...cache.publishTimes, [key]: { fetchedAt: Date.now(), times } } }));
	return times;
}

/** Releases in (base, latest] with their expected availability, soonest first. */
function pendingReleases(times, base, latest, config) {
	if (!times) return [];
	return Object.entries(times)
		.filter(([version]) => isStable(version) && compareVersions(version, base) > 0 && compareVersions(version, latest) <= 0)
		.map(([version, published]) => ({ version, eta: Date.parse(published) + config.cooldownDays * DAY_MS }))
		.filter((release) => Number.isFinite(release.eta))
		.sort((a, b) => a.eta - b.eta);
}

export function etaSentence(pending, latest, { label, markdown = false }) {
	if (!pending?.length) return undefined;
	const now = Date.now();
	const name = (version) => (markdown ? `**pi ${version}**` : `pi ${version}`);
	const next = pending[0];
	const last = pending.find((release) => release.version === latest);
	let text = `${label}: ${name(next.version)} around ${when(next.eta, now)}`;
	if (last && last !== next) text += `; latest ${name(last.version)} around ${when(last.eta, now)}`;
	return `${text}.`;
}

/** Debug aid for tuning registryCooldownDays: the hold implied by what the registry lists now. */
function debugCalibration(times, offered, config) {
	if (!DEBUG || !times) return;
	const now = Date.now();
	const listed = [...offered].filter((v) => isStable(v) && times[v]);
	const newestListed = listed.sort((a, b) => compareVersions(b, a))[0];
	const listedAges = listed.map((v) => now - Date.parse(times[v]));
	const unlistedAges = Object.keys(times)
		.filter((v) => !offered.has(v) && (!newestListed || compareVersions(v, newestListed) > 0))
		.map((v) => now - Date.parse(times[v]));
	const days = (ms) => `${(ms / DAY_MS).toFixed(2)}d`;
	const lower = unlistedAges.length ? `> ${days(Math.max(...unlistedAges))}` : "> ?";
	const upper = listedAges.length ? `<= ${days(Math.min(...listedAges))}` : "<= ?";
	debug(`observed registry hold: ${lower} and ${upper}; configured ${config.cooldownDays}d`);
}

function when(eta, now) {
	const date = DATE_FORMAT.format(eta);
	return eta <= now ? `${date} (due now; the registry hasn't listed it yet)` : `${date} (in ${duration(eta - now)})`;
}

function duration(ms) {
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
	const days = Math.floor(hours / 24);
	return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

// ---------------------------------------------------------------------------------------------
// Configuration, npm, cache and other helpers.

export function loadConfig() {
	let file = {};
	let error;
	if (existsSync(CONFIG_PATH)) {
		try {
			file = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		} catch (cause) {
			error = cause instanceof Error ? cause.message : String(cause);
			if (mode === "update") say(`Ignoring ${CONFIG_PATH}: ${error}`);
		}
	}
	const days = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
	const envDays = process.env.PI_REGISTRY_UPDATE_COOLDOWN_DAYS;
	const cooldownDays = days(envDays ? Number(envDays) : undefined) ?? days(file.registryCooldownDays) ?? DEFAULT_COOLDOWN_DAYS;
	let publishTimesRegistry = DEFAULT_PUBLISH_TIMES_REGISTRY;
	if (file.publishTimesRegistry === null || file.publishTimesRegistry === false || file.publishTimesRegistry === "") {
		publishTimesRegistry = undefined;
	} else if (typeof file.publishTimesRegistry === "string" && URL.canParse(file.publishTimesRegistry)) {
		publishTimesRegistry = file.publishTimesRegistry;
	}
	return { cooldownDays, publishTimesRegistry, path: CONFIG_PATH, exists: existsSync(CONFIG_PATH), error };
}

function releaseInfo(data) {
	const latest = typeof data?.version === "string" ? data.version.trim() : "";
	const current = runningPiVersion();
	if (!isStable(latest) || !isStable(current) || compareVersions(latest, current) <= 0) return undefined;
	return { latest, current, packageName: packageNameOf(data) };
}

function packageNameOf(data) {
	const name = typeof data?.packageName === "string" ? data.packageName.trim() : "";
	return PACKAGE_NAME_RE.test(name) ? name : DEFAULT_PACKAGE_NAME;
}

/** Stable versions in (current, latest], newest first. */
function newerThan(versions, current, latest) {
	return [...new Set(versions)]
		.filter((v) => isStable(v) && compareVersions(v, current) > 0 && compareVersions(v, latest) <= 0)
		.sort((a, b) => compareVersions(b, a));
}

function withVersion(data, version) {
	const { note: _releaseNote, ...rest } = data; // a release note would describe `latest`, not `version`
	return { ...rest, version };
}

/** registry + replace-registry-host as `npm ci` in pi's staging directory would see them. */
async function npmRegistryConfig({ fresh }) {
	const fingerprint = npmConfigFingerprint();
	const cached = readCache().npmConfig;
	if (
		!fresh &&
		cached?.fingerprint === fingerprint &&
		Date.now() - cached.fetchedAt < NPM_CONFIG_TTL_MS &&
		URL.canParse(cached.registry ?? "")
	) {
		return cached;
	}
	const values = {};
	for (const line of (await runNpm(["config", "get", "registry", "replace-registry-host"])).split(/\r?\n/)) {
		const match = /^([\w-]+)=(.*)$/.exec(line.trim());
		if (match) values[match[1]] = match[2].trim();
	}
	if (!values.registry || !URL.canParse(values.registry)) throw new Error("couldn't read the npm registry from `npm config get`");
	const npmConfig = { registry: values.registry, replaceRegistryHost: values["replace-registry-host"] };
	updateCache((cache) => ({ ...cache, npmConfig: { ...npmConfig, fingerprint, fetchedAt: Date.now() } }));
	return npmConfig;
}

/** Changes when the user npmrc is edited or registry-related npm env vars change. */
function npmConfigFingerprint() {
	const userConfig = process.env.npm_config_userconfig || process.env.NPM_CONFIG_USERCONFIG || join(homedir(), ".npmrc");
	let mtime = 0;
	try {
		mtime = statSync(userConfig).mtimeMs;
	} catch {
		// no user npmrc
	}
	const env = Object.entries(process.env)
		.filter(([name]) => /^npm_config_(registry|replace_registry_host|userconfig|globalconfig)$/i.test(name))
		.map(([name, value]) => `${name.toLowerCase()}=${value}`)
		.sort();
	return [userConfig, mtime, ...env].join("|");
}

function runNpm(args) {
	return new Promise((resolvePromise, reject) => {
		// Same `npm` (from PATH) that pi's updater uses, run from the installed release directory (has a
		// package.json, no .npmrc) so that, like pi's staging directory, no project .npmrc from the
		// directory pi was started in applies. Arguments are fixed tokens or a validated package name, so
		// the Windows command line needs no extra quoting.
		const options = { cwd: npmWorkingDirectory(), stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
		const child =
			process.platform === "win32"
				? spawn(`npm ${args.join(" ")}`, { ...options, shell: true })
				: spawn("npm", args, options);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const timer = setTimeout(() => child.kill(), NPM_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code === 0) resolvePromise(stdout);
			else reject(new Error(`\`npm ${args.join(" ")}\` failed: ${summarizeNpmError(stderr) || `exit code ${code}`}`));
		});
	});
}

function npmWorkingDirectory() {
	const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
	const current = runningPiVersion();
	const releaseDir = installRoot && current ? join(installRoot, "releases", current) : "";
	return releaseDir && existsSync(join(releaseDir, "package.json")) ? releaseDir : homedir();
}

function summarizeNpmError(stderr) {
	const lines = stderr
		.split(/\r?\n/)
		.map((line) => line.replace(/^npm (?:error|ERR!)\s*/, "").trim())
		.filter((line) => line && !/^(A complete log|code |syscall |errno |npm notice)/.test(line));
	return lines[0];
}

/** Version of the pi package whose CLI is the main script (argv[1]). */
export function runningPiVersion() {
	let dir = dirname(resolve(process.argv[1] ?? "."));
	for (let depth = 0; depth < 5; depth++) {
		const file = join(dir, "package.json");
		if (existsSync(file)) {
			try {
				const pkg = JSON.parse(readFileSync(file, "utf8"));
				if (typeof pkg.name === "string" && typeof pkg.version === "string") return pkg.version;
			} catch {
				// keep walking up
			}
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return "";
}

function readCache() {
	try {
		return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
	} catch {
		return {};
	}
}

function updateCache(change) {
	try {
		const temporary = `${CACHE_PATH}.${process.pid}.tmp`;
		writeFileSync(temporary, JSON.stringify(change(readCache())));
		renameSync(temporary, CACHE_PATH);
	} catch {
		// A cache that can't be written just means more lookups next time.
	}
}

function isStable(version) {
	return STABLE_VERSION_RE.test(version);
}

function compareVersions(a, b) {
	const x = STABLE_VERSION_RE.exec(a).slice(1).map(Number);
	const y = STABLE_VERSION_RE.exec(b).slice(1).map(Number);
	for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
	return 0;
}

export function formatDays(days) {
	return `${days} day${days === 1 ? "" : "s"}`;
}

function capitalize(text) {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function withTrailingSlash(url) {
	return url.endsWith("/") ? url : `${url}/`;
}

function say(message) {
	process.stderr.write(process.stderr.isTTY ? `\x1b[33m${message}\x1b[39m\n` : `${message}\n`);
}

function debug(message) {
	if (!DEBUG) return;
	if (mode === "update") {
		process.stderr.write(`[registry-update] ${message}\n`);
		return;
	}
	try {
		appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`); // never write into the TUI
	} catch {
		// ignore
	}
}
