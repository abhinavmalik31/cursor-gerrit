import {
	Command,
	Disposable,
	Event,
	EventEmitter,
	ThemeIcon,
	TreeDataProvider,
	TreeItem,
	TreeItemCollapsibleState,
	TreeView,
	window,
	workspace,
} from 'vscode';
import {
	getDefaultModel,
	getDefaultModelDisplay,
	onDidChangeModelSelection,
} from '../../lib/ai-review/modelSelector';
import { GerritExtensionCommands } from '../../commands/command-names';
import { GERRIT_MODEL_VIEW } from '../../lib/util/constants';

const SELECT_MODEL_COMMAND: Command = {
	command: GerritExtensionCommands.SELECT_AI_MODEL,
	title: 'Select AI Review Model',
};

/**
 * A one-row tree view that shows the AI Review model currently in use
 * and lets the user change it (via the title button or by clicking the
 * row). It mirrors the `gerrit.aiReview.defaultModel*` settings and
 * refreshes whenever they change.
 */
export class ModelTreeProvider
	implements TreeDataProvider<TreeItem>, Disposable
{
	private readonly _disposables: Disposable[] = [];

	public onDidChangeTreeDataEmitter: EventEmitter<
		TreeItem | undefined | null | void
	> = new EventEmitter<TreeItem | undefined | null | void>();
	public readonly onDidChangeTreeData: Event<
		TreeItem | undefined | null | void
	> = this.onDidChangeTreeDataEmitter.event;

	public constructor() {
		// Primary, instant signal: fires the moment a selection is
		// confirmed, before it persists to settings.
		this._disposables.push(onDidChangeModelSelection(() => this.refresh()));
		// Fallback for external edits to the settings directly.
		this._disposables.push(
			workspace.onDidChangeConfiguration((e) => {
				if (
					e.affectsConfiguration('gerrit.aiReview.defaultModel') ||
					e.affectsConfiguration(
						'gerrit.aiReview.defaultModelDisplay'
					)
				) {
					this.refresh();
				}
			})
		);
	}

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire();
	}

	public getTreeItem(element: TreeItem): TreeItem {
		return element;
	}

	public getChildren(element?: TreeItem): TreeItem[] {
		if (element) {
			return [];
		}

		const display = getDefaultModelDisplay();
		const isAuto = getDefaultModel().length === 0;

		const item = new TreeItem(
			display || (isAuto ? 'Auto' : getDefaultModel()),
			TreeItemCollapsibleState.None
		);
		item.iconPath = new ThemeIcon('sparkle');
		item.description = isAuto ? 'Cursor decides' : undefined;
		item.tooltip = isAuto
			? 'No model pinned — Cursor selects one automatically.' +
				' Click to change.'
			: 'Click to change the AI Review model.';
		item.command = SELECT_MODEL_COMMAND;
		item.contextValue = 'gerritModel';
		return [item];
	}

	public dispose(): void {
		this._disposables.forEach((d) => void d.dispose());
	}
}

let modelTreeView: TreeView<TreeItem> | null = null;
export function getOrCreateModelTreeProvider(): TreeView<TreeItem> {
	if (modelTreeView) {
		return modelTreeView;
	}
	return (modelTreeView = window.createTreeView(GERRIT_MODEL_VIEW, {
		treeDataProvider: new ModelTreeProvider(),
	}));
}
