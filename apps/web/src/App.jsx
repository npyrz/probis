const milestones = [
  'Connect to Polymarket event endpoints',
  'Display real-time multi-outcome market pricing',
  'Blend model-based and LLM-derived probability signals',
  'Support manual execution and live trade monitoring'
];

export default function App() {
  return (
    <main className="app-shell">
      <section className="hero-card">
        <p className="eyebrow">Probis workspace initialized</p>
        <h1>Prediction-market trading stack scaffolded for Step 1.</h1>
        <p className="lede">
          The backend, frontend, and environment wiring are in place so the next step can focus on live
          Polymarket connectivity rather than project setup.
        </p>

        <div className="status-grid">
          <article>
            <span>Backend</span>
            <strong>Express API</strong>
            <p>Ready for credentialed Polymarket client integration.</p>
          </article>
          <article>
            <span>Frontend</span>
            <strong>React Dashboard</strong>
            <p>Ready for event input and market display flows.</p>
          </article>
          <article>
            <span>AI Layer</span>
            <strong>Ollama Configured</strong>
            <p>Env placeholders set for local Gemma-backed analysis.</p>
          </article>
        </div>
      </section>

      <section className="roadmap-card">
        <div>
          <p className="eyebrow">Next implementation targets</p>
          <h2>Immediate work after environment setup</h2>
        </div>
        <ol>
          {milestones.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ol>
      </section>
    </main>
  );
}