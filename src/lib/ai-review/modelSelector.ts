import type {
	ModelListItem,
	ModelParameterDefinition,
	ModelParameterValue,
	ModelSelection,
} from '@cursor/sdk';
import { Event, EventEmitter, QuickPickItem, window } from 'vscode';
import { getConfiguration } from '../vscode/config';
import { log } from '../util/log';

const CUSTOM_ID = '__custom__';

/**
 * In-memory mirror of the persisted model selection. Set synchronously
 * the moment the user confirms a pick so the UI can update instantly,
 * without waiting for the (potentially slow) settings write + config
 * change event to round-trip through disk.
 */
interface CachedSelection {
	id: string;
	display: string;
	params: ModelParameterValue[];
}
let cachedSelection: CachedSelection | undefined;

const modelChangeEmitter = new EventEmitter<void>();
/** Fires as soon as the model selection changes (before it persists). */
export const onDidChangeModelSelection: Event<void> = modelChangeEmitter.event;

/**
 * Resolve the Cursor API key used for catalog/account operations
 * (e.g. `Cursor.models.list`) and for the inline AI chat. Prefers the
 * extension setting, then falls back to the `CURSOR_API_KEY` env var.
 */
export function resolveCursorApiKey(): string | undefined {
	const fromConfig = getConfiguration().get('gerrit.aiReview.apiKey');
	if (fromConfig && fromConfig.trim().length > 0) {
		return fromConfig.trim();
	}
	const fromEnv = process.env.CURSOR_API_KEY;
	if (fromEnv && fromEnv.trim().length > 0) {
		return fromEnv.trim();
	}
	return undefined;
}

/**
 * Ask the Cursor Agent SDK for the models available to the
 * authenticated user. Requires an API key; throws if the catalog
 * call fails (no key, offline, rate-limited, etc.).
 */
async function fetchAvailableModels(apiKey?: string): Promise<ModelListItem[]> {
	const sdk = await import('@cursor/sdk');
	return sdk.Cursor.models.list(apiKey ? { apiKey } : undefined);
}

interface ModelItem extends QuickPickItem {
	id: string;
	model?: ModelListItem;
	custom?: boolean;
}

interface VariantItem extends QuickPickItem {
	params?: ModelParameterValue[];
	customize?: boolean;
}

interface ParamItem extends QuickPickItem {
	paramId?: string;
	action?: 'done' | 'reset';
}

interface ValueItem extends QuickPickItem {
	value?: string;
	unset?: boolean;
}

/**
 * Pick a value for a single model parameter. Returns the chosen value,
 * `null` to clear it (use the model default), or `undefined` if the
 * user dismissed the picker.
 */
async function selectParameterValue(
	def: ModelParameterDefinition,
	currentValue: string | undefined
): Promise<string | null | undefined> {
	const items: ValueItem[] = [
		{
			label: '(default)',
			description: 'Use the model default',
			unset: true,
		},
	];
	for (const v of def.values) {
		items.push({
			label: v.displayName || v.value,
			description: v.value === currentValue ? '(current)' : undefined,
			value: v.value,
		});
	}

	const picked = await window.showQuickPick(items, {
		placeHolder: 'Select a value',
		title: 'Gerrit: ' + (def.displayName || def.id),
	});
	if (!picked) {
		return undefined;
	}
	return picked.unset ? null : (picked.value ?? null);
}

/**
 * Per-parameter editor. Loops on a summary list so the user can set
 * any combination of the model's parameters before confirming.
 * Returns the collected params, or `undefined` if cancelled.
 */
async function customizeParameters(
	defs: readonly ModelParameterDefinition[],
	initial: readonly ModelParameterValue[]
): Promise<ModelParameterValue[] | undefined> {
	if (defs.length === 0) {
		return [];
	}

	const current = new Map<string, string>();
	for (const p of initial) {
		current.set(p.id, p.value);
	}

	for (;;) {
		const items: ParamItem[] = defs.map((d) => {
			const valId = current.get(d.id);
			const valDef = d.values.find((v) => v.value === valId);
			return {
				label: d.displayName || d.id,
				description: valId ? valDef?.displayName || valId : '(default)',
				paramId: d.id,
			};
		});
		items.push({ label: '$(check) Done', action: 'done' });
		items.push({
			label: '$(discard) Reset to defaults',
			action: 'reset',
		});

		const picked = await window.showQuickPick(items, {
			placeHolder: 'Configure parameters, then choose Done',
			title: 'Gerrit: Customize Model Parameters',
		});
		if (!picked) {
			return undefined;
		}
		if (picked.action === 'done') {
			break;
		}
		if (picked.action === 'reset') {
			current.clear();
			continue;
		}

		const def = defs.find((d) => d.id === picked.paramId);
		if (!def) {
			continue;
		}
		const value = await selectParameterValue(def, current.get(def.id));
		if (value === undefined) {
			continue;
		}
		if (value === null) {
			current.delete(def.id);
		} else {
			current.set(def.id, value);
		}
	}

	return [...current.entries()].map(([id, value]) => ({ id, value }));
}

/**
 * Render a set of params as a short human label, using the model's
 * parameter definitions for friendly names (e.g. `Reasoning: High`).
 * Params without a `displayName` definition are opaque internal
 * toggles (e.g. `cyber`) and are omitted. Empty/all-hidden params
 * render as `Default`.
 */
function describeParams(
	params: readonly ModelParameterValue[],
	defs: readonly ModelParameterDefinition[]
): string {
	const named = params.filter((p) =>
		defs.some((d) => d.id === p.id && d.displayName)
	);
	if (named.length === 0) {
		return 'Default';
	}
	return named
		.map((p) => {
			const def = defs.find((d) => d.id === p.id);
			const name = def?.displayName || p.id;
			const valDef = def?.values.find((v) => v.value === p.value);
			const val = valDef?.displayName || p.value;
			return name + ': ' + val;
		})
		.join(', ');
}

/**
 * Resolve the `params` for a fetched model: offer its named variants
 * (presets) and/or a granular per-parameter editor. Only parameters
 * Cursor gave a human-readable `displayName` are surfaced; opaque
 * internal toggles are still applied by chosen variants but hidden
 * from the UI. Returns the chosen params, or `undefined` if cancelled.
 */
async function selectModelParameters(
	model: ModelListItem
): Promise<ModelParameterValue[] | undefined> {
	const variants = model.variants ?? [];
	const namedDefs = (model.parameters ?? []).filter((d) => !!d.displayName);
	const hasVariants = variants.length > 0;
	const hasParams = namedDefs.length > 0;

	if (!hasVariants && !hasParams) {
		return [];
	}
	if (!hasVariants) {
		return customizeParameters(namedDefs, []);
	}

	const namedCount = (v: { params: readonly ModelParameterValue[] }) =>
		v.params.filter((p) => namedDefs.some((d) => d.id === p.id)).length;

	const items: VariantItem[] = [];
	// A variant that sets no *named* params reads as the default.
	const hasEmptyVariant = variants.some((v) => namedCount(v) === 0);
	if (!hasEmptyVariant) {
		items.push({
			label: 'Default',
			description: 'Let the model decide',
			params: [],
		});
	}
	for (const v of variants) {
		// `displayName` is often just the model name (identical for
		// every variant), so prefer it only when it adds information
		// and otherwise describe the variant by its named params.
		const distinct = v.displayName && v.displayName !== model.displayName;
		const label = distinct
			? v.displayName
			: describeParams(v.params, namedDefs);
		const tags = [v.description, v.isDefault ? '(default)' : undefined]
			.filter((s): s is string => !!s)
			.join(' ');
		items.push({
			label,
			description: tags || undefined,
			params: v.params,
		});
	}
	if (hasParams) {
		items.push({
			label: '$(settings-gear) Customize parameters...',
			customize: true,
		});
	}

	const picked = await window.showQuickPick(items, {
		placeHolder: 'Select a variant or customize parameters',
		title: 'Gerrit: Parameters for ' + (model.displayName || model.id),
	});
	if (!picked) {
		return undefined;
	}
	if (picked.customize) {
		return customizeParameters(namedDefs, []);
	}
	return picked.params ?? [];
}

/**
 * Free-form parameter entry for a manually typed model id, where the
 * SDK gave us no parameter definitions to drive the picker. Returns
 * the parsed params, or `undefined` if cancelled.
 */
async function enterCustomModelParams(): Promise<
	ModelParameterValue[] | undefined
> {
	const raw = await window.showInputBox({
		prompt:
			'Optional parameters as id=value pairs, comma-separated' +
			' (e.g. reasoning=high). Leave empty for none.',
		placeHolder: 'id=value,id=value',
	});
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		return [];
	}

	const params: ModelParameterValue[] = [];
	for (const part of trimmed.split(',')) {
		const eq = part.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const id = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (id && value) {
			params.push({ id, value });
		}
	}
	return params;
}

export async function selectAiModel(): Promise<string | undefined> {
	const config = getConfiguration();
	const currentModel = config.get('gerrit.aiReview.defaultModel', '');
	const apiKey = resolveCursorApiKey();

	let fetched: ModelListItem[] = [];
	try {
		fetched = await fetchAvailableModels(apiKey);
	} catch (e) {
		log('Cursor.models.list failed: ' + String(e));
		void window.showWarningMessage(
			'Could not fetch available models from Cursor' +
				(apiKey ? '' : ' (no API key configured)') +
				'. You can still pick Auto or enter a model ID' +
				' manually.'
		);
	}

	const items: ModelItem[] = [
		{
			label: 'Auto (let Cursor decide)',
			description: currentModel === '' ? '(current)' : undefined,
			id: '',
		},
	];
	for (const m of fetched) {
		items.push({
			label: m.displayName || m.id,
			description: m.id === currentModel ? '(current)' : m.description,
			id: m.id,
			model: m,
		});
	}
	items.push({
		label: '$(edit) Enter custom model ID...',
		id: CUSTOM_ID,
		custom: true,
	});

	const selected = await window.showQuickPick(items, {
		placeHolder: 'Select default AI model for reviews',
		title: 'Gerrit: Select AI Review Model',
	});
	if (!selected) {
		return undefined;
	}

	let modelId = selected.id;
	let params: ModelParameterValue[] | undefined = [];

	if (selected.custom) {
		const customId = await window.showInputBox({
			prompt: 'Enter custom model ID (e.g., gpt-5.2)',
			placeHolder: 'model-id',
			validateInput: (value) => {
				if (!value || value.trim().length === 0) {
					return 'Model ID cannot be empty';
				}
				return null;
			},
		});
		if (!customId) {
			return undefined;
		}
		modelId = customId.trim();
		params = await enterCustomModelParams();
	} else if (selected.model) {
		params = await selectModelParameters(selected.model);
	}

	if (params === undefined) {
		return undefined;
	}

	const display = buildModelDisplay(modelId, selected.model, params);

	// Update the in-memory mirror and notify listeners first so the
	// Model view refreshes immediately, then persist in the background.
	cachedSelection = { id: modelId, display, params };
	modelChangeEmitter.fire();

	await Promise.all([
		config.update('gerrit.aiReview.defaultModel', modelId),
		config.update('gerrit.aiReview.defaultModelParams', params),
		config.update('gerrit.aiReview.defaultModelDisplay', display),
	]);

	return modelId;
}

/**
 * Build the human-readable label persisted for the Model view, e.g.
 * `Opus 4.8 · Reasoning: High`. Empty for the auto model.
 */
function buildModelDisplay(
	modelId: string,
	model: ModelListItem | undefined,
	params: readonly ModelParameterValue[]
): string {
	if (!modelId) {
		return '';
	}
	const name = model?.displayName || modelId;
	const summary = describeParams(params, model?.parameters ?? []);
	return summary && summary !== 'Default' ? name + ' · ' + summary : name;
}

export function getDefaultModel(): string {
	if (cachedSelection) {
		return cachedSelection.id;
	}
	return getConfiguration().get('gerrit.aiReview.defaultModel', '');
}

/** Human-readable label for the configured model, for the Model view. */
export function getDefaultModelDisplay(): string {
	if (cachedSelection) {
		return cachedSelection.display;
	}
	return getConfiguration().get('gerrit.aiReview.defaultModelDisplay', '');
}

/**
 * Full model selection (`{ id, params }`) for SDK callers that can
 * honor model parameters. Falls back to the `auto` model when no
 * default is configured.
 */
export function getDefaultModelSelection(): ModelSelection {
	const config = getConfiguration();
	const id = cachedSelection
		? cachedSelection.id
		: config.get('gerrit.aiReview.defaultModel', '');
	const params = cachedSelection
		? cachedSelection.params
		: config.get('gerrit.aiReview.defaultModelParams', []);

	const selection: ModelSelection = { id: id ? id : 'auto' };
	if (id && params.length > 0) {
		selection.params = params.map((p) => ({
			id: p.id,
			value: p.value,
		}));
	}
	return selection;
}
