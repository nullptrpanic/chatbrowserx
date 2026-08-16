import { createRoot } from 'react-dom/client';
import { App } from '../../side-panel/App';
import '../../side-panel/styles/tokens.css';
import '../../side-panel/styles/base.css';
import '../../side-panel/styles/shell.css';
import '../../side-panel/styles/conversation.css';
import '../../side-panel/styles/task-card.css';
import '../../side-panel/styles/composer.css';
import '../../side-panel/styles/forms.css';

const root = document.getElementById('root');

if (root === null) {
  throw new Error('Side Panel root element is missing.');
}

createRoot(root).render(<App />);
