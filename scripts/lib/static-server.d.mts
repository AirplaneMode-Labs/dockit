import type { Server } from 'node:http';
export interface ServeOptions {
  prefix?: string;
  onRequest?: (pathname: string, status: number) => void;
}
export function serveStatic(dir: string, port: number, opts?: ServeOptions): Promise<Server>;
export function closeServer(server: Server): Promise<void>;
