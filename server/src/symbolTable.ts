import { Location, Range } from 'vscode-languageserver';
import type { AnyNode, Program, Identifier, VariableDeclarator } from 'acorn';
import { getAST } from './util';
import { AST_NODE_TYPES } from "@typescript-eslint/types";

export const symbolTable = new Map<string, Location>();
const symbolInfoMap = new Map<string, string>();
const astMap = new Map<string, AnyNode>();

export function analyzeText(text: string, uri: string, clearCache?: boolean): Map<string, Location> {
	const table = new Map<string, Location>();

	let ast = astMap.get(uri);

	// If the AST is not cached or clearCache is true, parse it
	if (!ast || clearCache) {
		ast = getAST(text) as AnyNode;
	}

	// If the AST is successfully parsed, cache it
	if (ast) {
		astMap.set(uri, ast);
	} else {
		console.error(`Failed to parse AST for URI: ${uri}`);
		return table;
	}

	// Iterate through the AST to find symbols
	if (ast?.type === AST_NODE_TYPES.Program) {
		const program = ast as Program;
		// Iterate through the body of the program
		program.body.forEach((node, _i) => {
			processNode(node, uri, table, symbolInfoMap);
		});
	} else {
		// If the AST is not a Program, we assume it's a single node
		processNode(ast, uri, table, symbolInfoMap);
	}
	return table;
}

function processNode(node: AnyNode, uri: string, table: Map<string, Location>, symbolInfoMap: Map<string, string>): void {
	const nodeInfo = analyzeNode(node, uri);
	nodeInfo?.forEach(info => {
		table.set(info.name, info.loc);
		symbolInfoMap.set(info.name, info.info);
	});
}

function analyzeNode(node: AnyNode, uri: string): SymbolInfo[] | null {
	const symbolInfoArr: SymbolInfo[] = [];
	if (node.type === AST_NODE_TYPES.FunctionDeclaration && node.id && typeof node.id.name === 'string' && node.loc) {
		const identifier: Identifier = node.id as Identifier;
		const funcInfo = analyzeNode(identifier, uri);
		if (funcInfo) {
			symbolInfoArr.push(...funcInfo);
		}

		// If the function has a body, analyze its body for further symbols
		if (node.body && Array.isArray(node.body.body)) {
			node.body.body.forEach((childNode: AnyNode) => {
				const childInfo = analyzeNode(childNode, uri);
				if (childInfo) {
					symbolInfoArr.push(...childInfo);
				}
			});
		}

		// If the function has parameters, analyze them as well
		if (Array.isArray(node.params)) {
			node.params.forEach((param: AnyNode) => {
				const paramInfo = analyzeNode(param, uri);
				if (paramInfo) {
					symbolInfoArr.push(...paramInfo);
				}
			});
		}
	} else if (node.type === AST_NODE_TYPES.VariableDeclaration) {
		node.declarations.forEach((decl: VariableDeclarator) => {
			const identifier: Identifier = decl.id as Identifier;
			const declInfo = analyzeNode(identifier, uri);
			if (declInfo) {
				symbolInfoArr.push(...declInfo);
			}
		});
	} else if (node.type === AST_NODE_TYPES.Identifier && typeof node.name === 'string' && node.loc) {
		const name = node.name;
		const loc = Location.create(
			uri,
			Range.create(
				node.loc.start.line - 1,
				node.loc.start.column,
				node.loc.end.line - 1,
				node.loc.end.column
			)
		);
		const info = `Identifier used at line ${node.loc.start.line}`;
		symbolInfoArr.push({ name, loc, info });
	}

	return symbolInfoArr;
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

export interface SymbolInfo {
	name: string;
	loc: Location;
	info: string;
}