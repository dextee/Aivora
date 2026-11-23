import { useRef, useState } from "react";
import { criterionLine, TASK_NAMES } from "./IntentChips";
import walkthrough from "./hackathon-demo.json";
import { WorkspaceIcon } from "./WorkspaceIcon";
import "./overview.css";

const workspace = "/workspace";
const steps = ["Request", "Plan", "Approval"] as const;
const spotlight = ["research_demand", "storefront_draft", "marketing_plan"];
const gateNames: Record<string, string> = {
  approve_spend: "Advertising spend",
  approve_publish: "External publishing",
  approve_customer_comms: "Customer messages",
};

function Walkthrough() {
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);

  function goTo(next: number) {
    if (next === step) return;
    setStep(next);
    requestAnimationFrame(() => heading.current?.focus());
  }

  return (
    <section className="overview-demo" id="walkthrough" aria-labelledby="walkthrough-title">
      <div className="overview-demo-intro">
        <h2 id="walkthrough-title">Follow one request from start to approval.</h2>
        <p>A small retailer wants to sell 30 products. See how AIVORA turns that goal into a workflow and shows where the owner needs to decide.</p>
        <p className="overview-demo-context"><WorkspaceIcon name="info" size={16} /> Sample data · No account or API key required</p>
      </div>

      <div className="overview-console">
        <nav aria-label="Walkthrough steps" className="overview-steps">
          {steps.map((label, index) => (
            <button key={label} type="button" aria-current={step === index ? "step" : undefined} onClick={() => goTo(index)}>
              <span aria-hidden="true">{index + 1}</span>{label}
            </button>
          ))}
        </nav>
        <div className="overview-console-body">
          {step === 0 && <>
            <h3 ref={heading} tabIndex={-1}>Start with a measurable goal</h3>
            <blockquote className="overview-request">
              <WorkspaceIcon name="mic" size={21} />
              <p>“{walkthrough.statement}”</p>
            </blockquote>
            <p>In the workspace, you can say the request out loud or type it. Here, a captured sample lets you explore without a microphone.</p>
          </>}
          {step === 1 && <>
            <h3 ref={heading} tabIndex={-1}>Inspect the plan</h3>
            <p className="overview-criterion">{criterionLine(walkthrough.criterion)}</p>
            <ul className="overview-plan">
              {walkthrough.tasks.filter(({ id }) => spotlight.includes(id)).map(({ id, state }) => (
                <li key={id}>
                  <span>{TASK_NAMES[id]}</span>
                  <strong data-state={state}>{state === "done" ? "Prepared in sample" : "Queued"}</strong>
                </li>
              ))}
            </ul>
            <details>
              <summary>View all {walkthrough.tasks.length} plan steps</summary>
              <ol className="overview-all-steps">
                {walkthrough.tasks.map(({ id }) => <li key={id}>{TASK_NAMES[id]}</li>)}
              </ol>
            </details>
          </>}
          {step === 2 && <>
            <h3 ref={heading} tabIndex={-1}>Review what needs approval</h3>
            <p>The sample stops with these decisions waiting for the owner.</p>
            <ul className="overview-plan overview-gates">
              {walkthrough.gates.map(({ id, scope }) => (
                <li key={id}><WorkspaceIcon name="shield" size={18} /><span>{gateNames[id] ?? scope}</span><strong>Awaiting owner</strong></li>
              ))}
            </ul>
            <p className="overview-demo-footnote">This walkthrough sends no messages, publishes nothing, and spends no money.</p>
          </>}
          <div className="overview-console-actions">
            {step === steps.length - 1 ? <>
              <a className="overview-button overview-button-dark" href={workspace}>Open workspace <WorkspaceIcon name="arrow" size={19} /></a>
              <button className="overview-link-button" type="button" onClick={() => goTo(0)}>Start over</button>
            </> : (
              <button className="overview-button overview-button-dark" type="button" onClick={() => goTo(step + 1)}>
                {step === 0 ? "Show the plan" : "Review approval gates"} <WorkspaceIcon name="arrow" size={19} />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Overview() {
  return (
    <div className="overview">
      <a className="overview-skip" href="#overview-main">Skip to content</a>
      <header className="overview-header overview-bound">
        <a className="overview-brand" href="/" aria-label="AIVORA home">
          <img src="/logo.png" alt="" width="35" height="35" />AIVORA
        </a>
        <nav aria-label="Project navigation">
          <a className="overview-nav-demo" href="#walkthrough">Walkthrough</a>
          <a className="overview-button overview-button-outline" href={workspace}>Open workspace <WorkspaceIcon name="arrow" size={17} /></a>
        </nav>
      </header>
      <main id="overview-main" tabIndex={-1}>
        <section className="overview-hero overview-bound" aria-labelledby="overview-title">
          <div className="overview-hero-copy">
            <p className="overview-kicker">AI workspace for small businesses</p>
            <h1 id="overview-title">A goal you can say. <span>A plan you can see.</span></h1>
            <p className="overview-lede">
              Give AIVORA a business goal by voice or text. It turns the request into a measurable plan and shows what needs your approval.
            </p>
            <div className="overview-hero-actions">
              <a className="overview-button overview-button-dark" href="#walkthrough">Try the walkthrough <WorkspaceIcon name="arrow" size={20} /></a>
              <a className="overview-secondary" href={workspace}>Go to the assistant</a>
            </div>
          </div>
          <div className="overview-visual">
            <img className="overview-hero-photo" src="/aivora-small-business.webp"
              alt="A shop owner recording a request on her phone beside orders and parcels" width="1122" height="1402"
              fetchPriority="high" />
            <div className="overview-visual-card">
              <span className="overview-visual-icon"><WorkspaceIcon name="mic" size={20} /></span>
              <div>
                <p>Example request</p>
                <strong>“{walkthrough.statement}”</strong>
              </div>
              <a href="#walkthrough" aria-label="Explore the example request"><WorkspaceIcon name="arrow" size={19} /></a>
            </div>
          </div>
        </section>

        <div className="overview-proof">
          <ul className="overview-bound">
            <li><WorkspaceIcon name="mic" size={19} /> Voice and text</li>
            <li><WorkspaceIcon name="chart" size={19} /> Measurable goals</li>
            <li><WorkspaceIcon name="shield" size={19} /> Owner approval gates</li>
          </ul>
        </div>

        <div className="overview-bound"><Walkthrough /></div>
      </main>
      <footer className="overview-footer overview-bound">
        <a className="overview-brand" href="/" aria-label="AIVORA home">
          <img src="/logo.png" alt="" width="30" height="30" />AIVORA
        </a>
        <p>Objective-Driven Autonomous Intelligence</p>
        <a href="https://github.com/dextee/Aivora">Project repository <WorkspaceIcon name="arrow" size={16} /></a>
      </footer>
    </div>
  );
}
