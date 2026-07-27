import { API, Repository } from '../../types/vscode-extension-git';
import { arePathsEqual } from './worktree';
import { Disposable, Uri } from 'vscode';
import { log } from '../util/log';

const GIT_API_INIT_TIMEOUT_MS = 5000;
const OPEN_REPOSITORY_TIMEOUT_MS = 10000;

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number
): Promise<T | undefined> {
	let timeout: ReturnType<typeof setTimeout> | null = null;
	try {
		return await Promise.race([
			promise,
			new Promise<undefined>((resolve) => {
				timeout = setTimeout(() => resolve(undefined), timeoutMs);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

async function waitForGitAPIInitialized(gitAPI: API): Promise<void> {
	if (gitAPI.state === 'initialized') {
		return;
	}
	await new Promise<void>((resolve) => {
		let settled = false;
		let listener: Disposable | null = null;
		const finish = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			listener?.dispose();
			resolve();
		};
		const timeout = setTimeout(finish, GIT_API_INIT_TIMEOUT_MS);
		listener = gitAPI.onDidChangeState((state) => {
			if (state === 'initialized') {
				finish();
			}
		});
		if (gitAPI.state === 'initialized') {
			finish();
		}
	});
}

export async function openGitRepository(
	gitAPI: API,
	repoPath: string
): Promise<Repository | null> {
	const existingRepository = gitAPI.repositories.find((repository) =>
		arePathsEqual(repository.rootUri.fsPath, repoPath)
	);
	if (existingRepository) {
		return existingRepository;
	}

	await waitForGitAPIInitialized(gitAPI);
	try {
		const openedRepository = await withTimeout(
			gitAPI.openRepository(Uri.file(repoPath)),
			OPEN_REPOSITORY_TIMEOUT_MS
		);
		if (openedRepository === undefined) {
			log(`Timed out opening repository at ${repoPath}`);
			return null;
		}
		if (
			openedRepository &&
			arePathsEqual(openedRepository.rootUri.fsPath, repoPath)
		) {
			return openedRepository;
		}
		return (
			gitAPI.repositories.find((repository) =>
				arePathsEqual(repository.rootUri.fsPath, repoPath)
			) ?? null
		);
	} catch (error) {
		log(`Failed to open repository at ${repoPath}: ${String(error)}`);
		return null;
	}
}
