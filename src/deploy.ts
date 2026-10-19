import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { checkCdnCoverage, config, fail, findWorldDir, listPackFiles, type Pack, readJson, readManifest, versionArray, writeJson } from './config';

interface WorldPack {
	pack_id: string;
	version: number[];
}

if (!config.server) {
	fail('Set "server" in config.json to the folder your Bedrock Dedicated Server is in.');
}

const server = config.server;
const worldDir = await findWorldDir(server);

for (const pack of config.behaviorPacks) {
	await deploy(pack, 'behavior_packs', 'world_behavior_packs.json');
}

for (const pack of config.resourcePacks) {
	await deploy(pack, 'resource_packs', 'world_resource_packs.json');
}

await checkCdnCoverage();

console.log('Restart the server to load the changes.');

async function deploy(pack: Pack, packsFolder: string, worldPacksFile: string): Promise<void> {
	const manifest = await readManifest(pack);
	const target = join(server, packsFolder, pack.name);
	const files = await listPackFiles(pack);

	// Start clean so files deleted from the pack don't linger on the server
	await rm(target, { recursive: true, force: true });

	for (const file of files) {
		await Bun.write(join(target, file), Bun.file(join(pack.dir, file)));
	}

	// Make sure the world loads this version of the pack
	const worldPacksPath = join(worldDir, worldPacksFile);
	const worldPacks = await readJson<WorldPack[]>(worldPacksPath, []);
	const entry = { pack_id: manifest.uuid, version: versionArray(manifest.version) };
	const index = worldPacks.findIndex((worldPack) => worldPack.pack_id === manifest.uuid);

	if (index === -1) {
		worldPacks.push(entry);
	} else {
		worldPacks[index] = entry;
	}

	await writeJson(worldPacksPath, worldPacks);

	console.log(`Deployed ${pack.name} v${manifest.version} to ${packsFolder}/ (${files.length} files)`);
}
