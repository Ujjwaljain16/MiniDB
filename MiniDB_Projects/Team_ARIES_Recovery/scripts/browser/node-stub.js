// Stands in for Node builtins (fs, path, ...) in the browser bundle. Only the
// file-backed code paths reach them, and MiniDB.inMemory() never takes those.
function unavailable() {
  throw new Error('MiniDB: Node built-in modules are not available in the browser build; use MiniDB.inMemory()');
}

export const open = unavailable;
export const mkdir = unavailable;
export const readFile = unavailable;
export const writeFile = unavailable;
export const rename = unavailable;
export const rm = unavailable;
export const unlink = unavailable;
export const stat = unavailable;
export const join = unavailable;
export const dirname = unavailable;
export const resolve = unavailable;
export const createInterface = unavailable;
export const exec = unavailable;
export const spawn = unavailable;
export const promisify = unavailable;
export const constants = {};
export const promises = { open, mkdir, readFile, writeFile, rename, rm, unlink, stat };

export default { ...promises, promises, constants, join, dirname, resolve, createInterface, exec, spawn, promisify };
