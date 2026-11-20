import { existsSync, mkdirSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [releaseApp, archiveDirectory] = process.argv.slice(2);
if (!releaseApp || !archiveDirectory || existsSync(archiveDirectory)) {
  throw new Error("Provide release app and a new exclusive archive directory");
}
const value = (bundle, key) => execFileSync("/usr/libexec/PlistBuddy",
  ["-c", `Print :${key}`, path.join(bundle, "Contents/Info.plist")], { encoding: "utf8" }).trim();
if (value(releaseApp, "CFBundleIdentifier") !== "org.netlogochat.desktop") throw new Error("Unexpected application identity");
execFileSync("codesign", ["--verify", "--deep", "--strict", releaseApp]);
let running = "";
try { running = execFileSync("pgrep", ["-fl", "Contents/MacOS/MemoSim"], { encoding: "utf8" }); }
catch (error) { if (error.status !== 1) throw error; }
if (running.trim()) throw new Error("Quit MemoSim normally before installing; no process will be terminated");
const previous = ["MemoSim.app", "MemoSim 1.0.app", "MemoSim 1.0.1.app", "MemoSim 1.0.2.app", "MemoSim 1.0.3.app"]
  .map(name => path.join("/Applications", name)).filter(existsSync);
for (const bundle of previous) {
  if (value(bundle, "CFBundleIdentifier") !== "org.netlogochat.desktop") throw new Error(`Unexpected identity: ${bundle}`);
}
mkdirSync(archiveDirectory);
const moved = [];
try {
  for (const bundle of previous) {
    const target = path.join(archiveDirectory, path.basename(bundle));
    renameSync(bundle, target);
    moved.push([bundle, target]);
  }
  execFileSync("ditto", [releaseApp, "/Applications/MemoSim.app"], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--deep", "--strict", "/Applications/MemoSim.app"]);
  if (value("/Applications/MemoSim.app", "CFBundleShortVersionString") !== value(releaseApp, "CFBundleShortVersionString")) {
    throw new Error("Installed version does not match release");
  }
} catch (error) {
  // Preserve a partial installation for diagnosis and put every prior app back.
  if (existsSync("/Applications/MemoSim.app")) {
    renameSync("/Applications/MemoSim.app", path.join(archiveDirectory, "failed-install.app"));
  }
  for (const [original, archived] of moved.reverse()) renameSync(archived, original);
  throw error;
}
console.log(`Installed ${value(releaseApp, "CFBundleShortVersionString")} at /Applications/MemoSim.app`);
console.log(`Prior installations preserved at ${archiveDirectory}`);
