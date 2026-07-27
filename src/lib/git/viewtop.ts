import { tryExecAsync } from './gitCLI';
import * as fs from 'fs';
import * as path from 'path';

const VIEWTOP_UPSTREAM = 'origin/xgear-view';
const VIEWTOP_BRANCH_SUFFIX = '-viewtop';
const GIT_REMOTE_PREFIX = 'origin/';

interface BranchRef {
	readonly branch: string;
	readonly upstream: string;
	readonly worktreePath: string;
}

function arePathsEqual(firstPath: string, secondPath: string): boolean {
	return (
		path.relative(path.resolve(firstPath), path.resolve(secondPath)) === ''
	);
}

function normalizeBranchName(branch: string): string {
	return branch.trim().replace(/^refs\/heads\//, '');
}

/**
 * List every local branch together with its upstream and the worktree it is
 * checked out in (if any), using a single tab-delimited git call.
 */
async function listBranchRefs(repoPath: string): Promise<BranchRef[]> {
	const { success, stdout } = await tryExecAsync(
		"git for-each-ref --format='%(refname:short)%09" +
			"%(upstream:short)%09%(worktreepath)' refs/heads",
		{
			cwd: repoPath,
			silent: true,
		}
	);
	if (!success) {
		return [];
	}

	const refs: BranchRef[] = [];
	for (const line of stdout.split('\n')) {
		if (!line.trim()) {
			continue;
		}
		const [branch, upstream, worktreePath] = line.split('\t');
		refs.push({
			branch: branch ?? '',
			upstream: upstream ?? '',
			worktreePath: worktreePath ?? '',
		});
	}
	return refs;
}

/**
 * If 'repoPath' is an xgear viewtop, return the branch prefix xgear uses to
 * name the component worktree branches ("__<view>" or "__<id>__<view>").
 * Otherwise return null.
 */
function getViewtopPrefix(
	refs: readonly BranchRef[],
	repoPath: string
): string | null {
	for (const ref of refs) {
		if (
			ref.upstream === VIEWTOP_UPSTREAM &&
			ref.worktreePath &&
			arePathsEqual(ref.worktreePath, repoPath) &&
			ref.branch.endsWith(VIEWTOP_BRANCH_SUFFIX)
		) {
			return ref.branch.slice(
				0,
				ref.branch.length - VIEWTOP_BRANCH_SUFFIX.length
			);
		}
	}
	return null;
}

/**
 * Resolve the worktree that tracks a Gerrit target branch inside an xgear
 * viewtop.
 *
 * xgear creates one Git worktree per component, each on a branch named
 * "<prefix>-<component>" whose upstream is the component's Gerrit target
 * branch. The viewtop itself is a worktree on "<prefix>-viewtop" tracking
 * "origin/xgear-view". The component name matches the worktree's directory
 * name, so the path can be derived even when the worktree is in a detached
 * state (which quick-checkout itself causes).
 *
 * Returns 'repoPath' unchanged when it is not a viewtop (so non-xgear
 * repositories are unaffected), the resolved worktree path when a component
 * tracks 'targetBranch', or null when the repository is a viewtop but no
 * worktree tracks the target branch.
 */
export async function resolveWorktreePath(
	repoPath: string,
	targetBranch: string
): Promise<string | null> {
	const refs = await listBranchRefs(repoPath);
	const prefix = getViewtopPrefix(refs, repoPath);
	if (!prefix) {
		return repoPath;
	}

	const wantedUpstream =
		GIT_REMOTE_PREFIX + normalizeBranchName(targetBranch);
	if (wantedUpstream === VIEWTOP_UPSTREAM) {
		return repoPath;
	}

	const componentPrefix = `${prefix}-`;
	for (const ref of refs) {
		if (
			ref.upstream !== wantedUpstream ||
			!ref.branch.startsWith(componentPrefix) ||
			ref.branch.endsWith(VIEWTOP_BRANCH_SUFFIX)
		) {
			continue;
		}
		const component = ref.branch.slice(componentPrefix.length);
		if (!component || component.includes('/')) {
			continue;
		}
		const worktreePath = path.join(repoPath, component);
		if (
			arePathsEqual(path.dirname(worktreePath), repoPath) &&
			fs.existsSync(worktreePath)
		) {
			return worktreePath;
		}
	}
	return null;
}
