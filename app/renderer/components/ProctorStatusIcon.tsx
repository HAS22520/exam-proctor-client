/* eslint style/indent: ['warn', 2] -- 前端遵循两空格缩进。 */
export function ProctorStatusIcon({ state }: { state: 'pending' | 'failed' | 'success' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3 20 6v6c0 5-8 9-8 9s-8-4-8-9V6z" />
      <path d={state === 'success' ? 'm8.5 12 2.5 2.5 4.5-5' : state === 'failed' ? 'm9 9 6 6m0-6-6 6' : 'M12 7v5l3 1.5'} />
    </svg>
  );
}
