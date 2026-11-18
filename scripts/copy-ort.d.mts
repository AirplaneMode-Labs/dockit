export function ortFileNames(runtimeRoot: string): { wasm: string; factory: string };
export function copyOrt(runtimeRoot: string, to: string): void;
export function dropWasm(runtimeRoot: string, to: string): void;
