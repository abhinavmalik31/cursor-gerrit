import { getConfiguration } from '../vscode/config';
import { window } from 'vscode';

const DEFAULT_TIMEOUT_MINUTES = 5;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 120;

interface TimeoutPreset {
	readonly label: string;
	readonly minutes: number;
}

const PRESETS: readonly TimeoutPreset[] = [
	{
		label: '5 minutes (default)',
		minutes: 5,
	},
	{
		label: '10 minutes',
		minutes: 10,
	},
	{
		label: '15 minutes',
		minutes: 15,
	},
	{
		label: '20 minutes',
		minutes: 20,
	},
	{
		label: '30 minutes',
		minutes: 30,
	},
	{
		label: '45 minutes',
		minutes: 45,
	},
	{
		label: '60 minutes',
		minutes: 60,
	},
];

const CUSTOM_ID = '__custom__';

export function getAiAgentTimeoutMs(): number {
	const raw = getConfiguration().get(
		'gerrit.aiReview.timeoutMinutes',
		DEFAULT_TIMEOUT_MINUTES
	);
	const minutes = Number.isFinite(raw) ? Number(raw) : DEFAULT_TIMEOUT_MINUTES;
	return minutes * 60 * 1000;
}

export function getAiAgentTimeoutMinutes(): number {
	return getAiAgentTimeoutMs() / 60 / 1000;
}

export async function setAiAgentTimeout(): Promise<number | undefined> {
	const config = getConfiguration();
	const current = config.get(
		'gerrit.aiReview.timeoutMinutes',
		DEFAULT_TIMEOUT_MINUTES
	);

	const items: Array<{
		label: string;
		description?: string;
		minutes: number;
		id?: string;
	}> = PRESETS.map((p) => ({
		label: p.label,
		description: p.minutes === current ? '(current)' : undefined,
		minutes: p.minutes,
	}));

	items.push({
		label: '$(edit) Enter custom value (minutes)...',
		minutes: -1,
		id: CUSTOM_ID,
	});

	const selected = await window.showQuickPick(items, {
		placeHolder:
			'Select timeout for AI Review and Accept Suggestion ' +
			`(current: ${current} min)`,
		title: 'Gerrit: Set AI Agent Timeout',
	});

	if (!selected) {
		return undefined;
	}

	let minutes = selected.minutes;
	if (selected.id === CUSTOM_ID) {
		const entered = await window.showInputBox({
			prompt:
				'Enter timeout in minutes ' +
				`(${MIN_TIMEOUT_MINUTES}-${MAX_TIMEOUT_MINUTES})`,
			placeHolder: String(DEFAULT_TIMEOUT_MINUTES),
			value: String(current),
			validateInput: validateMinutes,
		});
		if (!entered) {
			return undefined;
		}
		minutes = Number(entered.trim());
	}

	await config.update('gerrit.aiReview.timeoutMinutes', minutes);

	void window.showInformationMessage(
		`AI agent timeout set to ${minutes} minute(s).`
	);

	return minutes;
}

function validateMinutes(value: string): string | null {
	const trimmed = value.trim();
	if (!trimmed) {
		return 'Please enter a number';
	}
	const n = Number(trimmed);
	if (!Number.isFinite(n) || !Number.isInteger(n)) {
		return 'Must be a whole number';
	}
	if (n < MIN_TIMEOUT_MINUTES || n > MAX_TIMEOUT_MINUTES) {
		return (
			`Must be between ${MIN_TIMEOUT_MINUTES} and ` +
			`${MAX_TIMEOUT_MINUTES} minutes`
		);
	}
	return null;
}
