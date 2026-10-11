const version = process.env.RELEASE_VERSION;
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  throw new TypeError('RELEASE_VERSION is missing or invalid. Run the release version parser first.');
}

const response = await fetch(`https://registry.npmjs.org/use-macro/${encodeURIComponent(version)}`, {
  headers: { accept: 'application/json' },
});

if (response.status === 404) {
  process.stdout.write(`Version ${version} is not present on npm.\n`);
} else if (response.ok) {
  throw new Error(`Version ${version} already exists on npm. Choose a new version.`);
} else {
  throw new Error(
    `Could not check npm for ${version}: registry returned HTTP ${response.status}. Publishing is stopped.`,
  );
}
