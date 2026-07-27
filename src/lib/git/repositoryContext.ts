import { Disposable, Event, EventEmitter } from 'vscode';
import { API, Repository } from '../../types/vscode-extension-git';
import {
	arePathsEqual,
	findWorktreePathsForTargetBranch,
	getChildWorktreePaths,
	isPathWithinFolder,
	normalizeBranchName,
	parseWorktreePaths,
} from './worktree';
import { openGitRepository } from './openRepository';
import { tryExecFileAsync } from './gitCLI';
import { log } from '../util/log';

const GIT_COMMAND_TIMEOUT_MS = 10000;

export type WorktreeResolution =
	| {
			readonly kind: 'matched';
			readonly repository: Repository;
	  }
	| {
			readonly kind: 'ambiguous';
			readonly targetBranch: string;
			readonly worktreePaths: readonly string[];
	  }
	| {
			readonly kind: 'notFound';
			readonly targetBranch: string;
	  }
	| {
			readonly kind: 'openFailed';
			readonly worktreePath: string;
	  };

export class RepositoryContext implements Disposable {
	private readonly _onDidChangeActiveRepository =
		new EventEmitter<Repository>();
	private _activeRepository: Repository;
	private _worktreePaths: Set<string>;

	public readonly onDidChangeActiveRepository: Event<Repository> =
		this._onDidChangeActiveRepository.event;

	public constructor(
		private readonly _gitAPI: API,
		public readonly controlRepository: Repository,
		worktreePaths: readonly string[]
	) {
		this._activeRepository = controlRepository;
		this._worktreePaths = new Set(worktreePaths);
	}

	public getActiveRepository(): Repository {
		return this._activeRepository;
	}

	public get worktreePaths(): readonly string[] {
		return [...this._worktreePaths].filter((worktreePath) =>
			isPathWithinFolder(
				this.controlRepository.rootUri.fsPath,
				worktreePath
			)
		);
	}

	public get childWorktreePaths(): readonly string[] {
		return getChildWorktreePaths(
			this.controlRepository.rootUri.fsPath,
			this.worktreePaths
		);
	}

	public get isViewTop(): boolean {
		return this.childWorktreePaths.length > 0;
	}

	public async refreshWorktrees(): Promise<void> {
		const result = await tryExecFileAsync(
			'git',
			['worktree', 'list', '--porcelain', '-z'],
			{
				cwd: this.controlRepository.rootUri.fsPath,
				silent: true,
				timeout: GIT_COMMAND_TIMEOUT_MS,
			}
		);
		if (result.success) {
			this._worktreePaths = new Set(parseWorktreePaths(result.stdout));
		}
	}

	public setActiveRepository(repository: Repository): void {
		if (
			arePathsEqual(
				this._activeRepository.rootUri.fsPath,
				repository.rootUri.fsPath
			)
		) {
			return;
		}
		this._activeRepository = repository;
		log(`Using active Gerrit worktree: ${repository.rootUri.fsPath}`);
		this._onDidChangeActiveRepository.fire(repository);
	}

	public async openRepositoryAtPath(
		repoPath: string
	): Promise<Repository | null> {
		return await openGitRepository(this._gitAPI, repoPath);
	}

	public async setActiveRepositoryPath(
		repoPath: string
	): Promise<Repository | null> {
		const repository = await this.openRepositoryAtPath(repoPath);
		if (repository) {
			this.setActiveRepository(repository);
		}
		return repository;
	}

	public async resolveWorktreeForBranch(
		targetBranch: string
	): Promise<WorktreeResolution> {
		if (!this.isViewTop) {
			return {
				kind: 'matched',
				repository: this.getActiveRepository(),
			};
		}

		await this.refreshWorktrees();
		const matches = findWorktreePathsForTargetBranch(
			targetBranch,
			this.childWorktreePaths
		);
		if (matches.length === 0) {
			return {
				kind: 'notFound',
				targetBranch: normalizeBranchName(targetBranch),
			};
		}
		if (matches.length > 1) {
			return {
				kind: 'ambiguous',
				targetBranch: normalizeBranchName(targetBranch),
				worktreePaths: matches,
			};
		}

		const repository = await this.openRepositoryAtPath(matches[0]);
		if (!repository) {
			return {
				kind: 'openFailed',
				worktreePath: matches[0],
			};
		}
		return {
			kind: 'matched',
			repository,
		};
	}

	public dispose(): void {
		this._onDidChangeActiveRepository.dispose();
	}
}

export async function bindToActiveRepository(
	repositoryContext: RepositoryContext,
	createDisposable: (repository: Repository) => Promise<Disposable>
): Promise<Disposable> {
	let activeDisposable = await createDisposable(
		repositoryContext.getActiveRepository()
	);
	let disposed = false;
	let update = Promise.resolve();
	const listener = repositoryContext.onDidChangeActiveRepository(
		(repository) => {
			update = update
				.then(async () => {
					activeDisposable.dispose();
					const nextDisposable = await createDisposable(repository);
					if (disposed) {
						nextDisposable.dispose();
						return;
					}
					activeDisposable = nextDisposable;
				})
				.catch((error) => {
					log(
						'Failed to rebind active repository listener: ' +
							String(error)
					);
				});
		}
	);
	return {
		dispose: () => {
			disposed = true;
			listener.dispose();
			activeDisposable.dispose();
		},
	};
}
