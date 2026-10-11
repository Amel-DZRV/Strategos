import { render } from 'preact';
import { App } from './app.tsx';
import './styles/tokens.css';
import './styles/app.css';
import './styles/map.css';
import { setTransport } from './state/commands.ts';
import { createConnection } from './state/connection.ts';
import { store } from './state/store.ts';

const connection = createConnection({ store });
setTransport(connection);
void connection.start();

render(<App />, document.getElementById('app')!);
