#!/usr/bin/env node

// Release helper for pi-gauge.
// Bumps the version, creates the release commit + tag, and pushes both so
// .github/workflows/release.yml publishes to npm via trusted publishing.
// Usage: node scripts/release.mjs <major|minor|patch>

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VALID_RELEASE_TYPES = new Set(["major", "minor", "patch"]);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

process.chdir(repoRoot);

const releaseType = process.argv[2];
if (!VALID_RELEASE_TYPES.has(releaseType)) {
  fail(
    `Expected release type to be one of: ${Array.from(VALID_RELEASE_TYPES).join(", ")}. Received: ${releaseType ?? "<missing>"}`,
  );
}

const packageName = readPackageName();
if (packageName !== "pi-gauge") {
  fail(`This release script is only intended for the pi-gauge package. Found package name: ${packageName}`);
}

const previousVersion = readPackageVersion();
console.log(`Preparing ${releaseType} release for ${packageName}@${previousVersion}`);

ensureCleanWorkingTree();
ensureMainBranch();
run("git", ["fetch", "origin", "main", "--tags"]);
run("git", ["pull", "--ff-only", "origin", "main"]);
// dist/ is tracked (pi installs git packages with no build step), so rebuild
// first and stage the output — npm version folds staged files into the
// release commit via `git commit`.
run("npm", ["run", "build", "--if-present"]);
run("npm", ["test", "--if-present"]);
// dist/ is tracked (pi installs git packages with no build step), so commit
// fresh build output first if the rebuild changed anything — `npm version`
// refuses to run on a dirty tree, and the tree was clean before the build,
// so any diff here is purely build output.
if (capture("git", ["status", "--porcelain"]).trim().length > 0) {
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", "chore: rebuild dist for release"]);
}
run("npm", ["pack", "--dry-run"]);

const createdTag = capture("npm", ["version", releaseType, "-m", "release v%s"])
  .trim()
  .split(/\r?\n/)
  .at(-1);

if (!createdTag) {
  fail("npm version did not return a tag name.");
}

const newVersion = readPackageVersion();
run("git", ["push", "origin", "main"]);
run("git", ["push", "origin", createdTag]);

console.log("");
console.log(`Release complete: ${previousVersion} -> ${newVersion}`);
console.log(`Created tag: ${createdTag}`);
console.log("Pushed refs: origin/main and the release tag");
console.log("npm publication has been triggered via .github/workflows/release.yml");

function ensureCleanWorkingTree() {
  const status = capture("git", ["status", "--porcelain"]).trim();
  if (status.length > 0) {
    fail("Git working tree is not clean. Commit or stash changes before releasing.");
  }
}

function ensureMainBranch() {
  const branch = capture("git", ["branch", "--show-current"]).trim();
  if (branch !== "main") {
    fail(`Releases must be cut from the main branch. Current branch: ${branch || "<detached>"}`);
  }
}

function readPackageName() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).name;
}

function readPackageVersion() {
  return JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
}

function run(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  execFileSync(command, args, { stdio: "inherit", cwd: repoRoot });
}

function capture(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "inherit"],
  });
}

function fail(message) {
  console.error(`Release aborted: ${message}`);
  process.exit(1);
}
