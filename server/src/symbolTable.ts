import { Location, Range } from 'vscode-languageserver';
import * as fs from 'fs';
import * as path from 'path';

export const symbolTable = new Map<string, Location>();
const symbolInfoMap = new Map<string, string>();

export function analyzeText(text: string, uri: string): Map<string, Location> {
	const table = new Map<string, Location>();
	const lines = text.split(/\r?\n/);

	lines.forEach((line, i) => {
		const funcMatch = line.match(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
		if (funcMatch) {
			const name = funcMatch[1];
			const col = line.indexOf(name);
			const loc = Location.create(uri, Range.create(i, col, i, col + name.length));
			table.set(name, loc);
			symbolInfoMap.set(name, `User-defined function at line ${i + 1}`);
		}

		const varMatch = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=/);
		if (varMatch) {
			const name = varMatch[1];
			const col = line.indexOf(name);
			const loc = Location.create(uri, Range.create(i, col, i, col + name.length));
			table.set(name, loc);
			symbolInfoMap.set(name, `Variable defined at line ${i + 1}`);
		}

		const includeMatch = line.match(/#include(?:_once)?\s*[<"]([^">]+)[>"]/);
		if (includeMatch) {
			const includePath = includeMatch[1];
			const fullPath = path.resolve(path.dirname(uri.replace('file:///', '').replace('%3A', ':')), includePath);
			if (fs.existsSync(fullPath)) {
				const content = fs.readFileSync(fullPath, 'utf8');
				const subSymbols = analyzeText(content, 'file:///' + fullPath);
				for (const [k, v] of subSymbols) { table.set(k, v); }
			}
		}
	});

	return table;
}

export function getWordAtPosition(line: string, char: number): string | null {
	const regex = /[A-Za-z_][A-Za-z0-9_]*/g;
	let match: RegExpExecArray | null;
	while ((match = regex.exec(line))) {
		const start = match.index;
		const end = start + match[0].length;
		if (char >= start && char <= end) {
			return match[0];
		}
	}
	return null;
}

export function getSymbolInfo(name: string): string | null {
	return symbolInfoMap.get(name) || null;
}
