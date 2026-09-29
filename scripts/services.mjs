// Service manager for simulation_trading_bot_v1: start, stop and check the bot and its helpers
// without guessing from process lists.
//
//   npm run services                    status of every service
//   npm run services -- start [name...]   start services that are not running (default: all)
//   npm run services -- stop [name...]    stop services (default: all)
//   npm run services -- restart [name...] stop then start
//
// Each start records the launched process in data/run/<name>.json. Stop only ever kills that
// recorded process tree, and only after checking its command line still matches what was
// launched, so another project's `node dist/index.js` (for example the v2 bot) is never touched.
// Logs go to logs/<name>.log and roll over to logs/<name>.1.log past 20 MB.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN = path.join(ROOT, "data", "run");
const LOGS = path.join(ROOT, "logs");
const ROLL_BYTES = 20 * 1024 * 1024;

// name: [command line, text that must appear in the launched process's command line]
const SERVICES = {
  bot: ["npm start", "npm start"],
  dashboard: ["node dashboard/server.js", "dashboard/server.js"],
  "report-cards": ["node report-cards/server.js", "report-cards/server.js"],
  alerts: ["node alerts/alerts.js", "alerts/alerts.js"],
};

fs.mkdirSync(RUN, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });
const pidFile = (name) => path.join(RUN, `${name}.json`);
const readPid = (name) => { try { return JSON.parse(fs.readFileSync(pidFile(name), "utf8")); } catch { return null; } };

/** Command line of a live process, or null if it is gone. */
function commandLine(pid) {
  try {
    const out = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** The recorded process for a service, if it is still the one we launched. */
function running(name) {
  const rec = readPid(name);
  if (!rec) return null;
  const cmd = commandLine(rec.pid);
  if (!cmd || !cmd.replace(/\\/g, "/").includes(SERVICES[name][1])) return null;
  return rec;
}

function rollLog(file) {
  try { if (fs.statSync(file).size > ROLL_BYTES) fs.renameSync(file, file.replace(/\.log$/, ".1.log")); } catch { /* no log yet */ }
}

function start(name) {
  const live = running(name);
  if (live) return console.log(`${name.padEnd(13)} already running (pid ${live.pid})`);
  const log = path.join(LOGS, `${name}.log`);
  rollLog(log);
  fs.appendFileSync(log, `\n===== ${new Date().toISOString()} starting ${name}: ${SERVICES[name][0]} =====\n`);
  // Launched with PowerShell's Start-Process running cmd.exe, which does the redirect itself. Children
  // spawned directly from Node (with a file handle, or cmd.exe with >>) lost all their output here.
  // The recorded pid is that cmd.exe, the root of the service's process tree.
  const ps = `$p = Start-Process -FilePath cmd.exe -ArgumentList '/d /c ${SERVICES[name][0]} >> "${log}" 2>&1' -WorkingDirectory '${ROOT}' -WindowStyle Hidden -PassThru; $p.Id`;
  const pid = Number(execFileSync("powershell.exe", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true }).trim());
  fs.writeFileSync(pidFile(name), JSON.stringify({ pid, cmd: SERVICES[name][0], startedAt: new Date().toISOString(), log: path.relative(ROOT, log) }, null, 2));
  console.log(`${name.padEnd(13)} started (pid ${pid}), log ${path.relative(ROOT, log)}`);
}

function stop(name) {
  const live = running(name);
  if (!live) { fs.rmSync(pidFile(name), { force: true }); return console.log(`${name.padEnd(13)} not running`); }
  try { execFileSync("taskkill", ["/PID", String(live.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); } catch { /* already exiting */ }
  fs.rmSync(pidFile(name), { force: true });
  console.log(`${name.padEnd(13)} stopped (pid ${live.pid})`);
}

function status() {
  for (const name of Object.keys(SERVICES)) {
    const live = running(name);
    let extra = "";
    if (name === "bot") {
      try {
        const books = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "books.json"), "utf8")).active.map((b) => b.id);
        const ages = books.map((id) => {
          try { return `${id} ${Math.round((Date.now() - Date.parse(JSON.parse(fs.readFileSync(path.join(ROOT, "data", id, "trades", "summary.json"), "utf8")).generatedAt)) / 1000)}s`; } catch { return `${id} ?`; }
        });
        extra = ` | summaries: ${ages.join(", ")}`;
      } catch { /* no registry yet */ }
    }
    console.log(`${name.padEnd(13)} ${live ? `running (pid ${live.pid}, since ${new Date(live.startedAt).toLocaleString()})` : "STOPPED"}${extra}`);
  }
}

const [cmd = "status", ...names] = process.argv.slice(2);
const targets = names.length ? names : Object.keys(SERVICES);
for (const n of targets) if (!SERVICES[n]) { console.error(`Unknown service "${n}". Known: ${Object.keys(SERVICES).join(", ")}`); process.exit(1); }
if (cmd === "status") status();
else if (cmd === "start") targets.forEach(start);
else if (cmd === "stop") targets.forEach(stop);
else if (cmd === "restart") { targets.forEach(stop); setTimeout(() => targets.forEach(start), 2000); }
else { console.error("Usage: npm run services -- [status|start|stop|restart] [bot|dashboard|report-cards|alerts]"); process.exit(1); }
