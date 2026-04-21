import type { Component } from "@ohp/tui";
import { theme } from "../../modes/theme/theme";

let buildInfo: { projectName: string; gitHash: string; dirty: boolean; buildTimestamp: string } | null = null;
try {
	// Dynamic import so missing file doesn't crash
	const mod = await import("../../build-info.generated");
	buildInfo = mod.BUILD_INFO;
} catch {
	// File doesn't exist yet (first run before generation)
}

export class BuildInfoLine implements Component {
	invalidate(): void {
		// Static content — nothing to invalidate
	}

	render(width: number): string[] {
		if (!buildInfo) return [];

		const parts: string[] = [buildInfo.projectName, buildInfo.gitHash];
		if (buildInfo.dirty) parts.push("dirty");

		// Format timestamp as readable local time
		const date = new Date(buildInfo.buildTimestamp);
		const formatted = date.toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			year: "numeric",
			hour: "numeric",
			minute: "2-digit",
			timeZoneName: "short",
		});
		parts.push(`Built ${formatted}`);

		const line = parts.join(" \u00b7 "); // middle dot
		return [theme.fg("dim", line.length > width ? `${line.slice(0, width - 1)}\u2026` : line)];
	}
}
