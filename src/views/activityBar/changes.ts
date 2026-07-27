import {
	Disposable,
	Event,
	EventEmitter,
	TreeDataProvider,
	TreeItem,
	TreeView,
	window,
} from 'vscode';
import {
	GERRIT_CHANGE_EXPLORER_VIEW,
	PERIODICAL_CHANGE_FETCH_INTERVAL,
} from '../../lib/util/constants';
import {
	bindToActiveRepository,
	RepositoryContext,
} from '../../lib/git/repositoryContext';
import { FileTreeView } from './changes/changeTreeView/fileTreeView';
import { RootTreeViewProvider } from './changes/rootTreeView';
import { ChangeTreeView } from './changes/changeTreeView';
import { onChangeLastCommit } from '../../lib/git/git';
import { TreeViewItem } from './shared/treeTypes';
import { ViewPanel } from './changes/viewPanel';
import * as path from 'path';

export class ChangesTreeProvider
	implements TreeDataProvider<TreeViewItem>, Disposable
{
	private static _instances: Set<ChangesTreeProvider> = new Set();
	private _disposables: Disposable[] = [];
	public rootViewProvider: RootTreeViewProvider;

	public onDidChangeTreeDataEmitter: EventEmitter<
		TreeViewItem | undefined | null | void
	> = new EventEmitter<TreeViewItem | undefined | null | void>();
	public readonly onDidChangeTreeData: Event<
		TreeViewItem | undefined | null | void
	> = this.onDidChangeTreeDataEmitter.event;

	public constructor(repositoryContext: RepositoryContext) {
		ChangesTreeProvider._instances.add(this);
		this.rootViewProvider = new RootTreeViewProvider(
			repositoryContext,
			this
		);
		this._disposables.push(FileTreeView.init());
		const interval = setTimeout(() => {
			this.refresh();
		}, PERIODICAL_CHANGE_FETCH_INTERVAL);
		this._disposables.push({
			dispose: () => clearInterval(interval),
		});
		void bindToActiveRepository(repositoryContext, async (repository) =>
			onChangeLastCommit(
				repository,
				() => {
					this.refresh();
				},
				false
			)
		).then((disposable) => this._disposables.push(disposable));
	}

	public static refesh(): void {
		this.getInstances().forEach((i) => i.refresh());
	}

	public static getInstances(): ChangesTreeProvider[] {
		return [...this._instances.values()];
	}

	public getParent(element: TreeViewItem): TreeViewItem | undefined {
		if (
			element instanceof ChangeTreeView &&
			element.parent instanceof ViewPanel
		) {
			return element.parent ?? undefined;
		}
		if (element instanceof ViewPanel) {
			return element.parent;
		}
		if (element instanceof RootTreeViewProvider) {
			return undefined;
		}
		return undefined;
	}

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	public async getChildren(element?: TreeViewItem): Promise<TreeViewItem[]> {
		if (!element) {
			return this.rootViewProvider.getChildren();
		}
		return element.getChildren?.() ?? [];
	}

	public async getTreeItem(element: TreeViewItem): Promise<TreeItem> {
		return await element.getItem();
	}

	public dispose(): void {
		ChangesTreeProvider._instances.delete(this);
		this._disposables.forEach((d) => void d.dispose());
	}
}

let changesTreeProvider: TreeView<TreeViewItem> | null = null;
export function getOrCreateChangesTreeProvider(
	repositoryContext: RepositoryContext
): TreeView<TreeViewItem> {
	if (changesTreeProvider) {
		return changesTreeProvider;
	}
	changesTreeProvider = window.createTreeView(GERRIT_CHANGE_EXPLORER_VIEW, {
		treeDataProvider: new ChangesTreeProvider(repositoryContext),
		showCollapseAll: true,
	});
	changesTreeProvider.description = path.basename(
		repositoryContext.getActiveRepository().rootUri.fsPath
	);
	repositoryContext.onDidChangeActiveRepository((repository) => {
		if (changesTreeProvider) {
			changesTreeProvider.description = path.basename(
				repository.rootUri.fsPath
			);
			ChangesTreeProvider.refesh();
		}
	});
	return changesTreeProvider;
}

export function getChangesTreeProvider(): TreeView<TreeViewItem> | null {
	return changesTreeProvider;
}
