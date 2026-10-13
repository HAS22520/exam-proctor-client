/* eslint style/indent: ['warn', 2], style/indent-binary-ops: ['warn', 2] -- 前端遵循两空格缩进，其余检查保持启用。 */
import { DEFAULT_PRODUCT_NAME } from '../../shared/branding';

export function Brand() {
  const name = typeof window === 'undefined' ? DEFAULT_PRODUCT_NAME : window.hydroClientName || DEFAULT_PRODUCT_NAME;
  return (
    <div className="brand">
      <img src="assets/icon.svg" alt="" />
      <span className="badge">{name}</span>
    </div>
  );
}
