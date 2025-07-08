export function stripStrings(line: string): string {
  return line.replace(/\\"([^\\"\\]|\\.)*\\"/g, (match) => ' '.repeat(match.length));
}