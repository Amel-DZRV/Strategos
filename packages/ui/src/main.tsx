import { render } from 'preact';
import { App } from './app.tsx';
import '@fontsource/jetbrains-mono/latin-400.css';
import '@fontsource/jetbrains-mono/latin-600.css';
import '@fontsource/jetbrains-mono/latin-700.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/map.css';
import './styles/chat.css';
import './styles/review.css';
import { setTransport } from './state/commands.ts';
import { createConnection } from './state/connection.ts';
import { store } from './state/store.ts';

const connection = createConnection({ store });
setTransport(connection);
void connection.start();

render(<App />, document.getElementById('app')!);
