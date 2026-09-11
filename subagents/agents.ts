/**
 * Agent discovery and configuration.
 *
 * Agents are markdown files with YAML frontmatter, read from
 * `<cwd>/.pi/agents/*.md` (project) and `~/.pi/agent/agents/*.md` (user).
 * Project agents shadow user agents with the same `name`.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const DEFAULT_AGENT_NAME = "default";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	systemPrompt: string;
	source: "builtin" | "user" | "project";
	filePath: string;
}

const DEFAULT_AGENT: AgentConfig = {
	name: DEFAULT_AGENT_NAME,
	description: "General-purpose subagent with full capabilities and isolated context",
	systemPrompt: [
		"You are a general-purpose implementation subagent.",
		"Inspect the relevant files and instructions, complete the assigned task, run appropriate checks, and report results concisely.",
		"Preserve unrelated work and stop with a precise explanation if genuinely blocked.",
	].join(" "),
	source: "builtin",
	filePath: "<builtin>",
};

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Values are `unknown` because `parseFrontmatter` runs a real YAML parser, so
 * any scalar or collection can appear here. A type alias rather than an
 * interface: only an alias picks up the implicit index signature that
 * `parseFrontmatter`'s `Record<string, unknown>` bound requires.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * Anything else yields no tools rather than throwing: this runs inside agent
 * discovery, where one bad file must not take down every other agent.
 */
function parseToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw
		.filter((t): t is string => typeof t === "string")
		.map((t) => t.trim())
		.filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function parseThinking(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const level = value.trim().toLowerCase();
	return (THINKING_LEVELS as string[]).includes(level) ? (level as ThinkingLevel) : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) return agents;

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
			continue;
		}

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseToolList(frontmatter.tools),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: parseThinking(frontmatter.thinking),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string): AgentDiscoveryResult {
	const userAgents = loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);
	const projectAgents = projectAgentsDir ? loadAgentsFromDir(projectAgentsDir, "project") : [];

	const agentMap = new Map<string, AgentConfig>([[DEFAULT_AGENT.name, DEFAULT_AGENT]]);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}
