import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Builds one platform-specific VSIX per target. `@cursor/sdk` eagerly loads
 * the native `sqlite3` module, so a VSIX only works on the OS/arch whose
 * native binary it bundles. We swap in the matching prebuilt `sqlite3`
 * binary and the matching `@cursor/sdk-<target>` package before each
 * `vsce package --target` run, then restore the host's binaries so local
 * development keeps working.
 *
 * Usage:
 *   ts-node -T scripts/package-platforms.ts            # all targets
 *   ts-node -T scripts/package-platforms.ts darwin-arm64 linux-x64
 */

interface Target {
	readonly vsce: string;
	readonly platform: NodeJS.Platform | string;
	readonly arch: string;
}

const TARGETS: readonly Target[] = [
	{ vsce: 'darwin-arm64', platform: 'darwin', arch: 'arm64' },
	{ vsce: 'darwin-x64', platform: 'darwin', arch: 'x64' },
	{ vsce: 'linux-x64', platform: 'linux', arch: 'x64' },
	{ vsce: 'linux-arm64', platform: 'linux', arch: 'arm64' },
	{ vsce: 'win32-x64', platform: 'win32', arch: 'x64' },
];

const ROOT = path.resolve(__dirname, '..');
const NM = path.join(ROOT, 'node_modules');
const DIST = path.join(ROOT, 'dist');
const SQLITE_DIR = path.join(NM, 'sqlite3');
const SQLITE_BIN = path.join(
	SQLITE_DIR,
	'build',
	'Release',
	'node_sqlite3.node'
);
const CURSOR_SCOPE = path.join(NM, '@cursor');
const CURSOR_NESTED = path.join(NM, '@cursor', 'sdk', 'node_modules', '@cursor');
const PREBUILD_BIN = path.join(NM, '.bin', 'prebuild-install');
const VSCE_BIN = path.join(NM, '.bin', 'vsce');

interface PackageJson {
	readonly version: string;
}

function readJson(file: string): PackageJson {
	return JSON.parse(fs.readFileSync(file, 'utf8')) as PackageJson;
}

const EXTENSION_VERSION = readJson(path.join(ROOT, 'package.json')).version;
const SDK_VERSION = readJson(
	path.join(NM, '@cursor', 'sdk', 'package.json')
).version;

function log(message: string): void {
	console.log(`[package-platforms] ${message}`);
}

function run(bin: string, args: readonly string[], cwd: string): void {
	execFileSync(bin, [...args], { cwd, stdio: 'inherit' });
}

/**
 * Absolute paths of every installed `@cursor/sdk-<platform>` package, in
 * both the top-level and the nested `@cursor/sdk/node_modules` scopes.
 */
function platformSdkDirs(): string[] {
	const dirs: string[] = [];
	for (const scope of [CURSOR_SCOPE, CURSOR_NESTED]) {
		if (!fs.existsSync(scope)) {
			continue;
		}
		for (const name of fs.readdirSync(scope)) {
			if (name.startsWith('sdk-')) {
				dirs.push(path.join(scope, name));
			}
		}
	}
	return dirs;
}

interface Backup {
	readonly root: string;
	readonly sqlite: string;
	readonly sdkDirs: ReadonlyArray<{
		readonly backup: string;
		readonly original: string;
	}>;
}

function createBackup(): Backup {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gerrit-pkg-'));
	const sqlite = path.join(root, 'node_sqlite3.node');
	fs.copyFileSync(SQLITE_BIN, sqlite);

	const sdkBackupRoot = path.join(root, 'cursor-platform');
	fs.mkdirSync(sdkBackupRoot);
	const sdkDirs = platformSdkDirs().map((original, index) => {
		const backup = path.join(sdkBackupRoot, String(index));
		fs.cpSync(original, backup, { recursive: true });
		return { backup, original };
	});

	return { root, sqlite, sdkDirs };
}

function restoreBackup(backup: Backup): void {
	log('restoring host sqlite3 + @cursor/sdk platform packages');
	fs.copyFileSync(backup.sqlite, SQLITE_BIN);
	for (const dir of platformSdkDirs()) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	for (const { backup: src, original } of backup.sdkDirs) {
		fs.mkdirSync(path.dirname(original), { recursive: true });
		fs.cpSync(src, original, { recursive: true });
	}
	fs.rmSync(backup.root, { recursive: true, force: true });
}

const MAGIC: Record<string, readonly number[][]> = {
	darwin: [
		[0xcf, 0xfa, 0xed, 0xfe],
		[0xca, 0xfe, 0xba, 0xbe],
	],
	linux: [[0x7f, 0x45, 0x4c, 0x46]],
	win32: [[0x4d, 0x5a]],
};

function verifyBinary(file: string, target: Target): void {
	const expected = MAGIC[target.platform];
	if (!expected) {
		return;
	}
	const header = Buffer.alloc(4);
	const fd = fs.openSync(file, 'r');
	try {
		fs.readSync(fd, header, 0, 4, 0);
	} finally {
		fs.closeSync(fd);
	}
	const ok = expected.some((magic) =>
		magic.every((byte, i) => header[i] === byte)
	);
	if (!ok) {
		throw new Error(
			`sqlite3 binary for ${target.vsce} has unexpected header ` +
				`0x${header.toString('hex')} (not a ${target.platform} binary)`
		);
	}
}

function fetchSqlite(target: Target): void {
	log(`fetching sqlite3 prebuild for ${target.vsce}`);
	if (fs.existsSync(SQLITE_BIN)) {
		fs.rmSync(SQLITE_BIN);
	}
	run(
		PREBUILD_BIN,
		['-r', 'napi', '--platform', target.platform, '--arch', target.arch],
		SQLITE_DIR
	);
	if (!fs.existsSync(SQLITE_BIN)) {
		throw new Error(`prebuild-install produced no binary for ${target.vsce}`);
	}
	verifyBinary(SQLITE_BIN, target);
}

/** Downloads (and caches) the given package tarball, returning its path. */
function packPackage(pkg: string, version: string, cache: string): string {
	const shortName = pkg.replace('@cursor/', 'cursor-');
	const tgz = path.join(cache, `${shortName}-${version}.tgz`);
	if (!fs.existsSync(tgz)) {
		run('npm', ['pack', `${pkg}@${version}`, '--pack-destination', cache], ROOT);
	}
	return tgz;
}

function ensureSdkPlatform(target: Target, cache: string): void {
	log(`installing @cursor/sdk-${target.vsce}`);
	for (const dir of platformSdkDirs()) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	const tgz = packPackage(`@cursor/sdk-${target.vsce}`, SDK_VERSION, cache);
	const dest = path.join(CURSOR_SCOPE, `sdk-${target.vsce}`);
	fs.mkdirSync(dest, { recursive: true });
	run('tar', ['xzf', tgz, '-C', dest, '--strip-components=1'], ROOT);
}

function packageTarget(target: Target): void {
	const outFile = path.join(
		DIST,
		`cursor--gerrit-${EXTENSION_VERSION}-${target.vsce}.vsix`
	);
	log(`packaging ${path.basename(outFile)}`);
	run(
		VSCE_BIN,
		['package', '--target', target.vsce, '--no-yarn', '-o', outFile],
		ROOT
	);
}

function main(): void {
	const requested = process.argv.slice(2);
	const targets = requested.length
		? TARGETS.filter((t) => requested.includes(t.vsce))
		: TARGETS;
	if (!targets.length) {
		throw new Error(
			`No matching targets. Known: ${TARGETS.map((t) => t.vsce).join(', ')}`
		);
	}

	fs.mkdirSync(DIST, { recursive: true });
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'gerrit-sdk-pack-'));
	const backup = createBackup();
	try {
		for (const target of targets) {
			log(`=== ${target.vsce} ===`);
			fetchSqlite(target);
			ensureSdkPlatform(target, cache);
			packageTarget(target);
		}
	} finally {
		restoreBackup(backup);
		fs.rmSync(cache, { recursive: true, force: true });
	}
	log(`done: ${targets.map((t) => t.vsce).join(', ')}`);
}

main();
