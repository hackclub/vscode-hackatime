#!/usr/bin/env node

const { execFileSync } = require('child_process');
const fs = require('fs');

const CHANGELOG_PATH = require.resolve('../CHANGELOG.md');
const PACKAGE_PATH = require.resolve('../package.json');
const PACKAGE_LOCK_PATH = require.resolve('../package-lock.json');
const packageJson = require(PACKAGE_PATH);
const HACKATIME_UPSTREAM = 'vscode-wakatime';
const HACKATIME_BUILD_RANGE = 1000;
const MAX_VERSION_PART = 65535;

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function git(args) {
  return run('git', args);
}

function usage() {
  console.error(`Usage: npm run release:prepare -- [--base <upstream-version>] [--build <hackatime-build>]

Examples:
  npm run release:prepare
  npm run release:prepare -- --base 30.2.7
  npm run release:prepare -- --base v30.2.7 --build 2

This prepares a packed three-part Marketplace version:
  <upstream-major>.<upstream-minor>.<(upstream-patch + 1) * 1000 + hackatime-build>

The upstream base is also recorded in package.json and CHANGELOG.md.`);
}

function parseArgs(args) {
  const parsed = {
    base: undefined,
    build: undefined,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    }

    if (arg === '--base' || arg === '--upstream-base') {
      parsed.base = args[++index];
      continue;
    }

    if (arg === '--build') {
      parsed.build = args[++index];
      continue;
    }

    if (!parsed.base) {
      parsed.base = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

function normalizeVersion(version, label) {
  const normalized = String(version || '').replace(/^v/, '');

  if (!/^\d+\.\d+\.\d+$/.test(normalized)) {
    throw new Error(`Expected a three-part ${label} version, got: ${version}`);
  }

  return normalized;
}

function parseVersion(version) {
  return normalizeVersion(version, 'release').split('.').map(Number);
}

function compareVersions(left, right) {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);

  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }

  return 0;
}

function parseBuild(build) {
  const parsed = Number(build);

  if (!Number.isInteger(parsed) || parsed < 1 || parsed >= HACKATIME_BUILD_RANGE) {
    throw new Error(`Expected --build to be an integer from 1 to ${HACKATIME_BUILD_RANGE - 1}, got: ${build}`);
  }

  return parsed;
}

function unpackHackatimeVersion(version) {
  const [major, minor, packedPatch] = parseVersion(version);

  return {
    upstreamBase: `${major}.${minor}.${Math.floor(packedPatch / HACKATIME_BUILD_RANGE) - 1}`,
    build: packedPatch % HACKATIME_BUILD_RANGE,
  };
}

function nextHackatimeBuild(currentVersion, upstreamBase) {
  const current = unpackHackatimeVersion(currentVersion);

  if (current.upstreamBase === upstreamBase && current.build > 0) {
    return current.build + 1;
  }

  return 1;
}

function packHackatimeVersion(upstreamBase, build) {
  const [major, minor, patch] = parseVersion(upstreamBase);
  const packedPatch = (patch + 1) * HACKATIME_BUILD_RANGE + build;

  if (packedPatch > MAX_VERSION_PART) {
    throw new Error(
      `Cannot pack upstream ${upstreamBase} build ${build}: patch part ${packedPatch} exceeds ${MAX_VERSION_PART}.`,
    );
  }

  return `${major}.${minor}.${packedPatch}`;
}

function latestUpstreamBaseFromMergedTags() {
  const tags = git(['tag', '--merged', 'HEAD', '--list', 'v*'])
    .split('\n')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.replace(/^v/, ''))
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
    .sort((left, right) => compareVersions(right, left));

  if (!tags.length) {
    throw new Error('Could not infer an upstream base tag from HEAD. Pass --base <version>.');
  }

  return tags[0];
}

function writeJson(path, data) {
  fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function updatePackageFiles(version, upstreamBase) {
  packageJson.version = version;
  packageJson.hackatime = {
    ...(packageJson.hackatime || {}),
    upstream: HACKATIME_UPSTREAM,
    upstreamVersion: upstreamBase,
  };
  writeJson(PACKAGE_PATH, packageJson);

  const packageLockJson = require(PACKAGE_LOCK_PATH);
  packageLockJson.version = version;

  if (packageLockJson.packages && packageLockJson.packages['']) {
    packageLockJson.packages[''].version = version;
  }

  writeJson(PACKAGE_LOCK_PATH, packageLockJson);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function updateChangelog(version, upstreamBase) {
  const changelog = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  const heading = `## ${version} (`;

  if (changelog.includes(heading)) {
    throw new Error(`CHANGELOG.md already has an entry for ${version}.`);
  }

  const entry = `## ${version} (${today()})\n\n- Based on upstream vscode-wakatime v${upstreamBase}.\n\n`;
  const updated = changelog.replace(/^(\s*# Changelog\n\n)/, `$1${entry}`);

  if (updated === changelog) {
    throw new Error('Could not find CHANGELOG.md title.');
  }

  fs.writeFileSync(CHANGELOG_PATH, updated);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const upstreamBase = normalizeVersion(args.base || latestUpstreamBaseFromMergedTags(), 'upstream base');
  const hackatimeBuild = args.build ? parseBuild(args.build) : nextHackatimeBuild(packageJson.version, upstreamBase);
  const nextVersion = packHackatimeVersion(upstreamBase, hackatimeBuild);

  if (compareVersions(nextVersion, packageJson.version) <= 0) {
    throw new Error(
      `Refusing to set ${nextVersion} because it is not greater than current package version ${packageJson.version}.`,
    );
  }

  updatePackageFiles(nextVersion, upstreamBase);
  updateChangelog(nextVersion, upstreamBase);
  console.log(`Prepared Hackatime release ${nextVersion}`);
  console.log(`Based on upstream vscode-wakatime v${upstreamBase}`);
  console.log(`Hackatime build ${hackatimeBuild}`);
  console.log(`Tag to publish: v${nextVersion}`);
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
