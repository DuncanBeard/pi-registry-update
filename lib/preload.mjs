// Loaded with `node --import` into `pi update` processes, by the launcher hook (lib/hook.mjs) or by
// the /update command. Makes pi's updater target the newest release the npm registry can serve.
import { installFetchHook } from "./core.mjs";

if (process.argv[2] === "update") installFetchHook("update");
