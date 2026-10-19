import { S3Client } from 'bun';
import { join } from 'node:path';
import { BUILD_INFO_PATH, type BuildInfo, cdnConfigPath, checkCdnCoverage, config, fail, readJson, readManifest, OUTPUT_DIR, writeJson } from './config';

const { R2_ACCOUNT_ID, R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL } = process.env;

if ((!R2_ACCOUNT_ID && !R2_ENDPOINT) || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET || !R2_PUBLIC_URL) {
	fail('Missing R2 settings. Copy .env.example to .env and fill it in.');
}

const force = process.argv.includes('--force');
const publicUrl = R2_PUBLIC_URL.replace(/\/+$/, '');
const buildInfo = await readJson<BuildInfo | undefined>(BUILD_INFO_PATH, undefined);

if (!buildInfo) {
	fail('Nothing has been built yet. Run "bun run build" first.');
}

const r2 = new S3Client({
	accessKeyId: R2_ACCESS_KEY_ID,
	secretAccessKey: R2_SECRET_ACCESS_KEY,
	bucket: R2_BUCKET,
	endpoint: R2_ENDPOINT ?? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
});

const cdnConfig = await readJson<Record<string, string>>(cdnConfigPath(), {});

for (const built of buildInfo.resourcePacks) {
	const pack = config.resourcePacks.find((resourcePack) => resourcePack.name === built.name);

	if (!pack || (await readManifest(pack)).version !== built.version) {
		fail(`${built.name} has changed since the last build. Run "bun run build" again.`);
	}

	await uploadZip(built.file, built.version);

	const url = `${publicUrl}/${built.file}`;

	await checkHeaders(url, Bun.file(join(OUTPUT_DIR, built.file)).size);

	// Replace any older version of this pack
	for (const key of Object.keys(cdnConfig)) {
		if (key.startsWith(`${built.uuid}_`)) {
			delete cdnConfig[key];
		}
	}

	cdnConfig[`${built.uuid}_${built.version}`] = url;
}

await writeJson(cdnConfigPath(), cdnConfig);

console.log(`Updated ${cdnConfigPath()}${config.server ? ' (restart the server to apply it)' : '. Copy it into your server folder, next to server.properties.'}`);

// The world only lists the new versions of these packs after "bun run deploy", which checks them then
await checkCdnCoverage(buildInfo.resourcePacks.map((built) => built.uuid));

async function uploadZip(file: string, version: string): Promise<void> {
	// The file name includes a hash of the zip, so an existing object is already identical
	if (await r2.exists(file)) {
		console.log(`${file} is already uploaded`);
		return;
	}

	// Players' games keep packs they've downloaded by UUID and version, so changed files under
	// an already-published version never reach players who have it
	const prefix = file.slice(0, file.lastIndexOf('_') + 1);
	const { contents } = await r2.list({ prefix });

	if (contents?.length && !force) {
		fail(`${file} has changed, but v${version} is already published. Bump the version in its manifest.json and rebuild, or pass --force to upload it anyway.`);
	}

	await r2.write(file, Bun.file(join(OUTPUT_DIR, file)), { type: 'application/zip' });

	console.log(`Uploaded ${file} to the ${R2_BUCKET} bucket`);
}

/** The game only accepts the download with exactly these headers. */
async function checkHeaders(url: string, size: number): Promise<void> {
	const response = await fetch(url, { method: 'HEAD' });
	const contentType = response.headers.get('content-type');
	const contentLength = Number(response.headers.get('content-length'));

	if (!response.ok) {
		fail(`${url} returned ${response.status}. Check that public access is turned on for the bucket and that R2_PUBLIC_URL is right.`);
	}

	if (contentType !== 'application/zip') {
		fail(`${url} is served as "${contentType}", but it has to be "application/zip".`);
	}

	if (contentLength !== size) {
		fail(`${url} reports ${contentLength} bytes, but the zip is ${size} bytes.`);
	}

	console.log(`${url} has the right headers`);
}
