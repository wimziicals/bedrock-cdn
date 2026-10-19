import { readdir } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

export const ROOT = resolve(import.meta.dir, '..');
export const OUTPUT_DIR = join(ROOT, 'output');
export const BUILD_INFO_PATH = join(OUTPUT_DIR, 'build.json');

// Top-level files and folders that are only used to develop a pack, so they're never shipped
const DEFAULT_EXCLUDE = ['.git', '.gitignore', 'bun.lock', 'node_modules', 'package-lock.json', 'package.json', 'src', 'tsconfig.json'];

export interface Pack {
	name: string;
	dir: string;
}

export interface Manifest {
	uuid: string;
	version: string;
	dependencies: { uuid?: string; version: string }[];
}

/** What "bun run build" produced, so "bun run upload" knows which zips to send. */
export interface BuildInfo {
	resourcePacks: { name: string; uuid: string; version: string; file: string }[];
}

interface ConfigFile {
	server?: string;
	resourcePacks?: string[];
	behaviorPacks?: string[];
	exclude?: string[];
}

export const config = await loadConfig();

export async function readManifest(pack: Pack): Promise<Manifest> {
	const path = join(pack.dir, 'manifest.json');
	const manifest = await readJson<any>(path, undefined);

	if (!manifest?.header?.uuid || !manifest.header.version) {
		fail(`${path} is missing, or has no header.uuid and header.version.`);
	}

	return {
		uuid: manifest.header.uuid,
		version: versionString(manifest.header.version),
		dependencies: (manifest.dependencies ?? []).map((dependency: { uuid?: string; version: string | number[] }) => ({
			uuid: dependency.uuid,
			version: versionString(dependency.version),
		})),
	};
}

export function versionArray(version: string): number[] {
	return version.split('.').map(Number);
}

/** Every file that ships with a pack, sorted, as forward-slash paths relative to the pack folder. */
export async function listPackFiles(pack: Pack): Promise<string[]> {
	const files: string[] = [];

	for (const entry of await readdir(pack.dir, { withFileTypes: true })) {
		if (config.exclude.has(entry.name)) {
			continue;
		}

		if (entry.isFile()) {
			files.push(entry.name);
		} else if (entry.isDirectory()) {
			for (const nested of await readdir(join(pack.dir, entry.name), { recursive: true, withFileTypes: true })) {
				if (nested.isFile()) {
					files.push(relative(pack.dir, join(nested.parentPath, nested.name)).split(sep).join('/'));
				}
			}
		}
	}

	return files.sort();
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
	const file = Bun.file(path);

	if (!(await file.exists())) {
		return fallback;
	}

	try {
		return (await file.json()) as T;
	} catch (error) {
		fail(`Couldn't read ${path}: ${(error as Error).message}`);
	}
}

export async function writeJson(path: string, data: unknown): Promise<void> {
	// Keeps number arrays like "version": [1, 0, 0] on one line
	const json = JSON.stringify(data, null, '\t').replace(/\[\s*(-?\d+(?:\s*,\s*-?\d+)*)\s*\]/g, (_, numbers: string) => `[${numbers.split(/\s*,\s*/).join(', ')}]`);

	await Bun.write(path, json + '\n');
}

/** Where cdn_config.json lives: the server folder, or output/ when no server is configured. */
export function cdnConfigPath(): string {
	return join(config.server ?? OUTPUT_DIR, 'cdn_config.json');
}

/** Finds the world folder from level-name in server.properties. */
export async function findWorldDir(server: string): Promise<string> {
	const properties = Bun.file(join(server, 'server.properties'));

	if (!(await properties.exists())) {
		fail(`There's no server.properties in ${server}. Check "server" in config.json.`);
	}

	const worldName = (await properties.text()).match(/^level-name=(.*)$/m)?.[1]?.trim();
	const worldDir = join(server, 'worlds', worldName ?? '');

	if (!worldName || !(await Bun.file(join(worldDir, 'level.dat')).exists())) {
		fail(`The world "${worldName}" from server.properties doesn't exist yet. Start the server once to create it.`);
	}

	return worldDir;
}

/**
 * BDS ignores cdn_config.json entirely unless it has a URL for every resource pack the world uses,
 * at the exact version the world loads. Warns about any that are missing.
 */
export async function checkCdnCoverage(ignoredPackIds: string[] = []): Promise<void> {
	if (!config.server) {
		return;
	}

	const worldDir = await findWorldDir(config.server);
	const worldPacks = await readJson<{ pack_id: string; version: number[] }[]>(join(worldDir, 'world_resource_packs.json'), []);
	const cdnConfig = await readJson<Record<string, string>>(cdnConfigPath(), {});
	const missing = worldPacks
		.filter((pack) => !ignoredPackIds.includes(pack.pack_id))
		.map((pack) => `${pack.pack_id}_${pack.version.join('.')}`)
		.filter((key) => !/^https?:\/\//.test(cdnConfig[key] ?? ''));

	if (missing.length > 0) {
		console.warn(`⚠ cdn_config.json has no URL for ${missing.join(', ')}, so BDS will ignore it and send packs itself. Make sure every resource pack the world uses is in "resourcePacks" in config.json, then run "bun run release".`);
	}
}

export function fail(message: string): never {
	console.error(`${message}`);
	process.exit(1);
}

async function loadConfig() {
	const raw = await readJson<ConfigFile | undefined>(join(ROOT, 'config.json'), undefined);

	if (!raw) {
		fail('config.json not found. Copy config.example.json to config.json and fill it in.');
	}

	const toPack = (path: string): Pack => {
		const dir = resolve(ROOT, path);
		return { name: basename(dir), dir };
	};

	return {
		server: raw.server ? resolve(ROOT, raw.server) : undefined,
		resourcePacks: (raw.resourcePacks ?? []).map(toPack),
		behaviorPacks: (raw.behaviorPacks ?? []).map(toPack),
		exclude: new Set(raw.exclude ?? DEFAULT_EXCLUDE),
	};
}

function versionString(version: string | number[]): string {
	return Array.isArray(version) ? version.join('.') : version;
}
