/* eslint style/indent: ['warn', 2], style/indent-binary-ops: ['warn', 2] -- 前端遵循两空格缩进，其余检查保持启用。 */
import { createRoot } from 'react-dom/client';
import { WaitingPage } from '../pages/WaitingPage';

createRoot(document.getElementById('root')!).render(<WaitingPage />);
