import { zipSync } from 'fflate';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { BUILD_INFO_PATH, type BuildInfo, config, fail, listPackFiles, readManifest, OUTPUT_DIR, type Pack, writeJson } from './config';

// A fixed timestamp makes the zip depend only on the pack's files, so an unchanged pack rebuilds to the same zip
const ZIP_TIMESTAMP = new Date('2000-01-01T00:00:00');

if (config.resourcePacks.length === 0) {
	fail('There are no resourcePacks in config.json.');
}

await checkDependencyVersions();
await rm(OUTPUT_DIR, { recursive: true, force: true });
await mkdir(OUTPUT_DIR, { recursive: true });

const buildInfo: BuildInfo = { resourcePacks: [] };

for (const pack of config.resourcePacks) {
	const manifest = await readManifest(pack);
	const files: Record<string, Uint8Array> = {};

	// manifest.json has to be at the top of the zip, not inside a folder
	for (const file of await listPackFiles(pack)) {
		files[file] = await Bun.file(join(pack.dir, file)).bytes();
	}

	const zip = zipSync(files, { level: 9, mtime: ZIP_TIMESTAMP });
	// The hash gives changed contents a new URL, so a CDN can never serve a stale copy
	const hash = new Bun.CryptoHasher('sha256').update(zip).digest('hex').slice(0, 8);
	const file = `${pack.name.replace(/[^A-Za-z0-9._-]+/g, '-')}_v${manifest.version}_${hash}.zip`;

	await Bun.write(join(OUTPUT_DIR, file), zip);

	buildInfo.resourcePacks.push({ name: pack.name, uuid: manifest.uuid, version: manifest.version, file });

	console.log(`Built output/${file} (${zip.length} bytes)`);
}

await writeJson(BUILD_INFO_PATH, buildInfo);

/** Packs that depend on each other have to agree on each other's versions. */
async function checkDependencyVersions(): Promise<void> {
	const packs: { pack: Pack; uuid: string; version: string; dependencies: { uuid?: string; version: string }[] }[] = [];

	for (const pack of [...config.resourcePacks, ...config.behaviorPacks]) {
		packs.push({ pack, ...(await readManifest(pack)) });
	}

	for (const { pack, dependencies } of packs) {
		for (const dependency of dependencies) {
			const target = packs.find((other) => other.uuid === dependency.uuid);

			if (target && target.version !== dependency.version) {
				fail(`${pack.name}/manifest.json depends on ${target.pack.name} v${dependency.version}, but ${target.pack.name} is v${target.version}.`);
			}
		}
	}
}
