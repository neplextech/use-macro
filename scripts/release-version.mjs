import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CHANNEL_PATTERN = /^[a-z][a-z0-9-]*$/;
const VERSION_LIKE_COMMIT = /^\d+\.\d+\.\d+(?:-.+)?$/;

function validateIdentifiers(value, { prerelease }) {
  if (!value) return false;
  const identifiers = value.split('.');
  return identifiers.every((identifier) => {
    if (!/^[0-9A-Za-z-]+$/.test(identifier)) return false;
    if (prerelease && /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) return false;
    return true;
  });
}

function parseSemver(value, { allowBuild = true } = {}) {
  if (typeof value !== 'string') return undefined;
  const match = VERSION_PATTERN.exec(value);
  if (!match || (!allowBuild && match[5])) return undefined;
  if (match[4] && !validateIdentifiers(match[4], { prerelease: true })) return undefined;
  if (match[5] && !validateIdentifiers(match[5], { prerelease: false })) return undefined;
  return { major: match[1], minor: match[2], patch: match[3], prerelease: match[4], build: match[5] };
}

function validateTag(tag, { stable = false } = {}) {
  if (!CHANNEL_PATTERN.test(tag)) throw new TypeError(`Invalid npm dist-tag: ${tag}`);
  if (tag === 'latest' && !stable) throw new TypeError('The latest dist-tag is reserved for stable releases.');
  return tag;
}

/** Parse a workflow dispatch input into a validated package version and npm dist-tag. */
export function parseReleaseInput(input, currentVersion, { trigger = 'dispatch', timestamp = Date.now() } = {}) {
  if (typeof input !== 'string' || input.length === 0 || input.trim() !== input) {
    throw new TypeError('Release version input must be a non-empty string without surrounding whitespace.');
  }
  if (trigger !== 'dispatch' && trigger !== 'push') throw new TypeError(`Unsupported release trigger: ${trigger}`);

  if (CHANNEL_PATTERN.test(input)) {
    if (trigger === 'push') throw new TypeError('Channel-only versions are supported only by workflow_dispatch.');
    const channel = validateTag(input);
    const base = parseSemver(currentVersion);
    if (!base) throw new TypeError(`package.json version is not valid SemVer: ${currentVersion}`);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0)
      throw new TypeError('Release timestamp must be a non-negative safe integer.');
    return { version: `${base.major}.${base.minor}.${base.patch}-${channel}.${timestamp}`, tag: channel };
  }

  const parsed = parseSemver(input, { allowBuild: false });
  if (!parsed) throw new TypeError(`Invalid release version: ${input}`);
  if (!parsed.prerelease) return { version: input, tag: 'latest' };
  const channel = parsed.prerelease.split('.')[0];
  if (!channel || !CHANNEL_PATTERN.test(channel)) {
    throw new TypeError(`Prerelease channel must be a lowercase npm dist-tag: ${channel ?? ''}`);
  }
  return { version: input, tag: validateTag(channel) };
}

/** Inspect one commit subject exactly. Unrelated messages do not trigger a release. */
export function parsePushCommit(subject, currentVersion) {
  if (typeof subject !== 'string' || !VERSION_LIKE_COMMIT.test(subject)) return undefined;
  return parseReleaseInput(subject, currentVersion, { trigger: 'push' });
}

function runCli() {
  const mode = process.argv[2];
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  let release;
  if (mode === '--dispatch') {
    release = parseReleaseInput(process.env.RELEASE_INPUT ?? '', packageJson.version, { trigger: 'dispatch' });
  } else if (mode === '--push') {
    const subject = execFileSync('git', ['log', '-1', '--format=%s'], { encoding: 'utf8' }).replace(/\r?\n$/, '');
    release = parsePushCommit(subject, packageJson.version);
  } else {
    throw new TypeError('Usage: node scripts/release-version.mjs --dispatch|--push');
  }

  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error('GITHUB_OUTPUT is required when running the release parser in CI.');
  if (!release) {
    appendFileSync(output, 'publish=false\n');
    return;
  }
  appendFileSync(output, `publish=true\nversion=${release.version}\ntag=${release.tag}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Release input is invalid.'}\n`);
    process.exitCode = 1;
  }
}
