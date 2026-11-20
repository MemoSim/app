import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [baseApp, outputDirectory, version] = process.argv.slice(2);
if (!baseApp || !outputDirectory || !/^\d+\.\d+\.\d+(-beta\.\d+)?$/.test(version ?? "")) {
  throw new Error("Usage: node chat-dev/package-preview.mjs <preserved-base.app> <new-output-directory> <x.y.z[-beta.n]>");
}
if (existsSync(outputDirectory)) throw new Error("Refusing to overwrite an existing release directory");
if (!existsSync(path.join(baseApp, "Contents/Info.plist"))) throw new Error("Base application is missing");
const classes = path.join(root, "netlogo-gui/target/classes");
if (!existsSync(classes)) throw new Error("Compile the GUI before packaging");
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: "inherit" });
mkdirSync(outputDirectory);
const prerelease = version.includes("-beta.");
const bundle = path.join(outputDirectory, prerelease ? `MemoSim ${version}.app` : "MemoSim.app");
run("ditto", [baseApp, bundle]);
const contents = path.join(bundle, "Contents");
const jar = path.join(contents, "app/01-netlogo-gui-classes.jar");
run("jar", ["--create", "--file", jar, "-C", classes, "."]);
const plist = path.join(contents, "Info.plist");
const numeric = version.split("-")[0];
const buildVersion = process.env.MEMOSIM_BUILD_VERSION ?? (prerelease ? `${numeric}.${version.split(".").at(-1)}` : numeric);
const baseVersion = execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", plist], { encoding: "utf8" }).trim();
for (const [key, value] of Object.entries({
  CFBundleName: prerelease ? `MemoSim ${version}` : "MemoSim",
  CFBundleIdentifier: prerelease ? `org.netlogochat.desktop.${version.replaceAll(".", "-")}` : "org.netlogochat.desktop",
  CFBundleShortVersionString: numeric,
  CFBundleVersion: buildVersion,
})) run("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ${value}`, plist]);
let hasReleaseVersion = false;
try {
  execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :MemoSimReleaseVersion", plist], { stdio: "ignore" });
  hasReleaseVersion = true;
} catch { /* Older base bundles do not contain the additional release key. */ }
run("/usr/libexec/PlistBuddy", ["-c", hasReleaseVersion ? `Set :MemoSimReleaseVersion ${version}` : `Add :MemoSimReleaseVersion string ${version}`, plist]);
const cfgPath = path.join(contents, "app/MemoSim.cfg");
const cfg = readFileSync(cfgPath, "utf8")
  .replace(/^java-options=-Dmemosim.release.version=.*\n?/gm, "")
  .replace(/java-options=-Djpackage.app-version=.*/, `java-options=-Djpackage.app-version=${numeric}\njava-options=-Dmemosim.release.version=${version}`)
  .replace(/java-options=-Dnetlogo.product.name=.*/, `java-options=-Dnetlogo.product.name=MemoSim ${version}`)
  .replace(/java-options=-Xdock:name=.*/, `java-options=-Xdock:name=MemoSim ${version}`);
writeFileSync(cfgPath, cfg);
const manual = path.join(root, "chat-dev/manual");
if (existsSync(path.join(manual, "validation-report.json"))) {
  const validation = JSON.parse(readFileSync(path.join(manual, "validation-report.json"), "utf8"));
  if (validation.errors.length) throw new Error("Documentation validation has unresolved errors");
  cpSync(manual, path.join(contents, "docs"), { recursive: true });
}
run("codesign", ["--force", "--deep", "--sign", "-", bundle]);
run("codesign", ["--verify", "--deep", "--strict", bundle]);
run("plutil", ["-lint", plist]);
const files = ["InterfacePanel.scala", "InterfaceTab.scala", "WidgetPanel.scala", "MemoSimLayout.scala", "MemoSimTheme.scala"]
  .map(name => `netlogo-gui/src/main/app/interfacetab/${name}`)
  .concat(["netlogo-gui/src/main/app/App.scala", "netlogo-gui/src/main/app/Splash.scala", "netlogo-gui/src/main/app/AboutWindow.scala", "netlogo-gui/src/main/app/HelpActions.scala", "netlogo-gui/src/main/swing/QuickHelp.scala", "netlogo-gui/src/main/swing/ProductBranding.scala", "netlogo-gui/src/main/swing/NetLogoIcon.scala", "netlogo-gui/src/main/chat/ChatDock.scala", "netlogo-gui/src/main/chat/ToggleChatAction.scala", "netlogo-gui/src/main/chat/ChatDebug.scala", "netlogo-gui/src/main/window/MonitorWidget.scala", "netlogo-gui/src/test/swing/ProductBrandingTests.scala", "netlogo-gui/src/test/app/MemoSimHelpTests.scala", "netlogo-gui/src/test/app/interfacetab/MemoSimLayoutTests.scala", "netlogo-gui/src/test/app/interfacetab/MemoSimLifecycleTests.scala", "chat-dev/package-preview.mjs"]);
for (const relative of files) {
  const target = path.join(outputDirectory, "source-snapshot", relative);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(path.join(root, relative), target);
}
writeFileSync(path.join(outputDirectory, "release-manifest.json"), JSON.stringify({
  product: "MemoSim", version, bundleVersion: buildVersion, createdUTC: new Date().toISOString(),
  status: `${prerelease ? "local preview" : "local integrated release"}; ad-hoc signed; not notarized`,
  baseVersion, baseApplication: baseApp, installedApplicationModified: false,
  sourceBaseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceState: "Uncommitted source with preexisting user changes; relevant source snapshot included",
  applicationJarSHA256: createHash("sha256").update(readFileSync(jar)).digest("hex"),
  implemented: ["Concurrent simulation, controls and live analytics", "Responsive control grid and compact narrow-window layout", "Collapsible chat dock retains WebView, history and draft", "Latest installed base server and System Dynamics modeler retained", "Blue, teal and violet section accents with light/dark surfaces", "Minimum-size-safe scrolling and preserved model coordinates"],
  checks: ["Bundle signature and plist validated; compilation and runtime results recorded separately after verification"],
  limitations: ["Native widgets retain their existing internal styling", "Large widget collections scroll; custom chart crosshairs and synchronized numeric slider adjuncts are not implemented", "3D uses the existing original layout", "Runtime engine version remains unchanged for compatibility"],
  rollback: "Quit MemoSim and restore the preserved baseApplication; never replace or delete user data for rollback.",
}, null, 2) + "\n");
console.log(bundle);
