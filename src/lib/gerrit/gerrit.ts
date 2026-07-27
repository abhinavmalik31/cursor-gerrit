import {
	API,
	GitExtension,
	Repository,
} from '../../types/vscode-extension-git';
import { arePathsEqual, parseWorktreePaths } from '../git/worktree';
import { extensions, QuickPickItem, window, workspace } from 'vscode';
import { RepositoryContext } from '../git/repositoryContext';
import { GitCommit, tryExecFileAsync } from '../git/gitCLI';
import { openGitRepository } from '../git/openRepository';
import { isGerritCommit } from '../git/commit';
import { wait } from '../util/util';
import { log } from '../util/log';

const GIT_COMMAND_TIMEOUT_MS = 10000;

interface GitRepoQuickPickItem extends QuickPickItem {
	readonly repoPath: string;
}

let repositoryContextPromise: Promise<RepositoryContext | null> | null = null;

async function tryGetGitAPI(): Promise<false | API> {
	for (let i = 0; i < 1000 * 60; await wait(1000), i += 1000) {
		try {
			const extension =
				extensions.getExtension<GitExtension>('vscode.git');
			if (!extension) {
				continue;
			}

			if (!extension.isActive) {
				await extension.activate();
			}

			return extension.exports.getAPI(1);
		} catch (error) {
			log('Failed to get git API, retrying in 1 second');
		}
	}

	log(
		'Failed to get git API after 60 seconds, ' +
			'it looks like VSCode has disconnected from the host'
	);
	return false;
}

async function getOpenedGitRoot(gitAPI: API): Promise<string | null> {
	for (const folder of workspace.workspaceFolders ?? []) {
		if (folder.uri.scheme !== 'file') {
			continue;
		}
		const result = await tryExecFileAsync(
			'git',
			['rev-parse', '--show-toplevel'],
			{
				cwd: folder.uri.fsPath,
				silent: true,
				timeout: GIT_COMMAND_TIMEOUT_MS,
			}
		);
		if (result.success && result.stdout.trim()) {
			return result.stdout.trim();
		}
	}
	return gitAPI.repositories[0]?.rootUri.fsPath ?? null;
}

async function getWorktreePaths(rootPath: string): Promise<string[]> {
	const result = await tryExecFileAsync(
		'git',
		['worktree', 'list', '--porcelain', '-z'],
		{
			cwd: rootPath,
			silent: true,
			timeout: GIT_COMMAND_TIMEOUT_MS,
		}
	);
	if (!result.success) {
		return [rootPath];
	}
	return parseWorktreePaths(result.stdout);
}

async function usesGerrit(rootPath: string): Promise<boolean> {
	const result = await tryExecFileAsync(
		'git',
		['log', '--all', '--format=%B', '-z', '-n', '50'],
		{
			cwd: rootPath,
			silent: true,
			timeout: GIT_COMMAND_TIMEOUT_MS,
		}
	);
	return (
		result.success &&
		isGerritCommit({
			hash: '',
			message: result.stdout,
		} as GitCommit)
	);
}

async function createRepositoryContext(): Promise<RepositoryContext | null> {
	const gitAPI = await tryGetGitAPI();
	if (!gitAPI) {
		return null;
	}
	const rootPath = await getOpenedGitRoot(gitAPI);
	if (!rootPath) {
		log('Did not find a Git repository in this workspace');
		return null;
	}
	if (!(await usesGerrit(rootPath))) {
		log(`No recent Gerrit commits found for ${rootPath}`);
		return null;
	}

	const [controlRepository, worktreePaths] = await Promise.all([
		openGitRepository(gitAPI, rootPath),
		getWorktreePaths(rootPath),
	]);
	if (!controlRepository) {
		return null;
	}

	const repositoryContext = new RepositoryContext(
		gitAPI,
		controlRepository,
		worktreePaths
	);
	log(
		`Using Gerrit ${
			repositoryContext.isViewTop ? 'viewtop' : 'repository'
		}: ${rootPath}`
	);
	return repositoryContext;
}

export async function getRepositoryContext(): Promise<RepositoryContext | null> {
	repositoryContextPromise ??= createRepositoryContext();
	const repositoryContext = await repositoryContextPromise;
	if (!repositoryContext) {
		repositoryContextPromise = null;
	}
	return repositoryContext;
}

export async function getGerritRepo(): Promise<Repository | null> {
	return (await getRepositoryContext())?.getActiveRepository() ?? null;
}

export async function pickGitRepo(): Promise<Repository | null> {
	const repositoryContext = await getRepositoryContext();
	if (!repositoryContext) {
		return null;
	}
	await repositoryContext.refreshWorktrees();
	const items: GitRepoQuickPickItem[] = repositoryContext.worktreePaths.map(
		(worktreePath) => ({
			label: worktreePath,
			description: arePathsEqual(
				worktreePath,
				repositoryContext.getActiveRepository().rootUri.fsPath
			)
				? 'Active command context'
				: undefined,
			repoPath: worktreePath,
		})
	);
	const selection = await window.showQuickPick(items, {
		title: 'Choose the Gerrit worktree used by commands',
	});
	if (!selection) {
		return null;
	}
	return await repositoryContext.setActiveRepositoryPath(selection.repoPath);
}
