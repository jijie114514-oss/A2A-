import { ensure } from '../errors.js';
import { STORE_NAMES } from './shared.js';
import { FileStore } from './file.js';
import { MemoryStore } from './memory.js';
import { PostgresStore } from './postgres.js';

export { FileStore, MemoryStore, PostgresStore };
export * from './shared.js';

/** 按 STARHALL_STORE 选驱动；file 驱动保持本地 0.5.0-local 的全部行为。 */
export function createStore(options = {}) {
  const name = options.store || 'file';
  ensure(STORE_NAMES.includes(name), 'invalid_config', `未知存储驱动 ${name}（可选 ${STORE_NAMES.join(' / ')}）`);
  if (name === 'memory') return new MemoryStore(options);
  if (name === 'postgres') return new PostgresStore(options);
  return new FileStore(options);
}
