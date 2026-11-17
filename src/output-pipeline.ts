import type { OutputConfig } from "./config.ts";
import { hasMinimumSavings, isExcludedCommand, reduceJsonArrayColumnar, reduceOutput, utf8ByteLength, validateExtractedOutput } from "./output.ts";
import type { ExtractionTelemetry, ProviderCacheTelemetry } from "./stats.ts";

export interface OutputExtraction {
	text: string;
	telemetry: ProviderCacheTelemetry;
}

export interface OutputReduction {
	text: string;
	removedChars: number;
	extractionOutcome?: Exclude<keyof ExtractionTelemetry, "attempts">;
	providerUsage?: ProviderCacheTelemetry;
}

/** One eligible text block: choose a strategy, validate savings, then archive before returning it. */
export async function reduceToolOutput(
	text: string,
	config: OutputConfig,
	ports: {
		command: string;
		signal: AbortSignal;
		/** Undefined means unavailable/failed extraction; cancellation rejects. */
		extract: () => Promise<OutputExtraction | undefined>;
		archive: (text: string) => string | undefined;
	},
): Promise<OutputReduction> {
	const result: OutputReduction = { text, removedChars: 0 };
	ports.signal.throwIfAborted();
	const fromBytes = utf8ByteLength(text);
	if (config.mode === "off" || (text.split(/\r?\n/).length <= config.maxLines && fromBytes <= config.maxBytes)) return result;
	const limits = {
		maxLines: config.maxLines, maxBytes: config.maxBytes,
		minSavingsBytes: config.minSavingsBytes, minSavingsRatio: config.minSavingsRatio,
	};
	let reduction: { text: string; reduced: boolean } = reduceJsonArrayColumnar(text, limits);
	let strategy = "columnar";
	if (!reduction.reduced) {
		const wantsExtraction = config.mode === "extract" && config.model.trim().length > 0
			&& fromBytes >= config.extractMinBytes && !isExcludedCommand(ports.command, config.extractExclude);
		if (wantsExtraction) {
			const extraction = await ports.extract();
			ports.signal.throwIfAborted();
			result.providerUsage = extraction?.telemetry;
			if (extraction?.text) {
				const validated = validateExtractedOutput(text, extraction.text, { ...limits, smartOptions: limits });
				reduction = validated;
				strategy = validated.strategy;
				if (strategy === "extract") result.extractionOutcome = "accepted";
				else if (validated.rejectionReason === "insufficient-benefit") result.extractionOutcome = "fallbackSavings";
				else if (validated.rejectionReason === "empty-extraction") result.extractionOutcome = "fallbackError";
				else result.extractionOutcome = "fallbackEvidence";
			} else {
				reduction = reduceOutput(text, limits);
				strategy = "smart";
				result.extractionOutcome = "fallbackError";
			}
		} else {
			reduction = reduceOutput(text, limits);
			strategy = "smart";
		}
	}
	if (!reduction.reduced) return result;
	const render = (id: string): string => `${reduction.text}\n[skill-optimizer:${strategy}; full=${id}]`;
	if (!hasMinimumSavings(fromBytes, utf8ByteLength(render(`sko:${"0".repeat(43)}`)), config.minSavingsBytes, config.minSavingsRatio)) return result;
	ports.signal.throwIfAborted();
	const archive = ports.archive(text);
	if (!archive) return result;
	result.text = render(archive);
	result.removedChars = Math.max(0, text.length - result.text.length);
	return result;
}
