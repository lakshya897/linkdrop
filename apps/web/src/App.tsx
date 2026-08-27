import { PROTOCOL_VERSION } from '@linkdrop/protocol';

function App() {
  return (
    <div className="container">
      <header className="header">
        <h1>LINKDROP</h1>
        <p className="subtitle">Project foundation ready.</p>
      </header>
      <main className="main-content">
        <div className="card">
          <h2>Technical Foundation Details</h2>
          <ul>
            <li>
              <strong>Protocol Version:</strong> {PROTOCOL_VERSION}
            </li>
            <li>
              <strong>Frameworks:</strong> React 19 + TypeScript + Vite
            </li>
            <li>
              <strong>Status:</strong> Day 1 Baseline Validated
            </li>
          </ul>
        </div>
      </main>
    </div>
  );
}

export default App;
