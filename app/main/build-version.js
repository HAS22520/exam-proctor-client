// Fixed-width YYYYMMDDNN values sort lexically; do not fall back to semver.
function buildVersion(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{9}$/.test(value)) throw new Error('buildVersion 必须是 YYYYMMDDNN 格式的 10 位字符串');
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) throw new Error('buildVersion 日期无效');
  return value;
}
module.exports = { buildVersion };
