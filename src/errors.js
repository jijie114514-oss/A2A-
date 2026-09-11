export class AppError extends Error {
  constructor(code, message, status = 400, details) { super(message); this.code = code; this.status = status; this.details = details; }
}
export function ensure(condition, code, message, status = 400) {
  if (!condition) throw new AppError(code, message, status);
}
export function object(value, keys) {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'invalid_input', '需要 JSON 对象');
  for (const key of Object.keys(value)) ensure(keys.includes(key), 'invalid_input', `未知字段：${key}`);
  return value;
}
export function string(value, name, max = 2000, required = true) {
  if (!required && (value === undefined || (typeof value === 'string' && !value.trim()))) return '';
  ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'invalid_input', `${name} 必须是 1–${max} 字符的文本`);
  return value.trim();
}
