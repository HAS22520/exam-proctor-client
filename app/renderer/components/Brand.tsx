import { DEFAULT_PRODUCT_NAME } from '../../shared/branding';

export function Brand() {
  const name = typeof window === 'undefined' ? DEFAULT_PRODUCT_NAME : window.hydroClientName || DEFAULT_PRODUCT_NAME;
  return <div className="brand"><img src="assets/icon.svg" alt=""/><span className="badge">{name}</span></div>;
}
