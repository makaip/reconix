// Single source of truth for the scroll story. The 3D rig reads the camera keyframes and focus
// ids; the DOM sections read the copy. Beat i is centered when the page is scrolled i viewports.

export type Vec3 = [number, number, number]

export interface Beat {
  id: string
  title: string
  body: string
  details: string[]
  // Camera position and the point it looks at, in model units (the app window is ~10 x 6.4).
  camera: Vec3
  target: Vec3
  // Model parts that lift toward the viewer while this beat is centered (see Model.tsx ids).
  focus: string[]
  // Which side the copy sits on (wide screens). The model is drawn on the other side.
  side: 'left' | 'right'
}

export const BEATS: Beat[] = [
  {
    id: 'top',
    title: 'Keeping humans in control',
    body: 'Reconix is a pentesting browser with an AI copilot. The agent maps the attack surface and drafts payloads. Anything that changes state waits for your approval.',
    details: [],
    camera: [8.2, 4.6, 21.5],
    target: [0.2, -0.2, 0],
    focus: [],
    side: 'left'
  },
  {
    id: 'map',
    title: 'It maps the attack surface while you browse',
    body: 'Every page you or the agent load feeds a live sitemap. Anything suspicious lands in Findings, ranked by severity, with the request that produced it attached.',
    details: ['Passive sitemap built from crawl history', 'Findings ranked by severity', 'Evidence linked to the original request'],
    camera: [-0.4, 1.8, 10.5],
    target: [-3.9, 0.1, 0],
    focus: ['finding-0', 'site-3'],
    side: 'left'
  },
  {
    id: 'probe',
    title: 'It tells you what it suspects, and where',
    body: 'The copilot reads the live DOM of the page under test. When an input looks reflected, it points at that exact field and explains why before it sends anything.',
    details: ['Parser and analyzer subagents', 'Hypotheses tied to specific elements', 'Every agent action visible in the page'],
    camera: [9.4, 2.4, 7.0],
    target: [-0.4, 0.45, 0],
    focus: ['input-email'],
    side: 'left'
  },
  {
    id: 'traffic',
    title: 'The traffic tooling is already in the window',
    body: 'Intercept, Repeater, WebSocket frames, and request history sit under the page. You never switch to a separate proxy to see what the agent sent.',
    details: ['Intercept and edit requests in flight', 'Repeater to save, edit, and resend', 'HAR export from the network log'],
    camera: [-9.2, 0.5, 7.2],
    target: [0.1, -1.9, 0],
    focus: ['net-2', 'tab-network'],
    side: 'right'
  },
  {
    id: 'draft',
    title: 'It drafts the payload. You read it first.',
    body: 'Suggested payloads and next steps arrive in the copilot with the reasoning behind them. An evaluator checks every result against the hypothesis, so weak findings get thrown out.',
    details: ['Orchestrator with three specialized subagents', 'Reasoning shown with each suggestion', 'Evidence-based evaluation of results'],
    camera: [1.2, 2.4, 9.2],
    target: [3.8, 0.7, 0],
    focus: ['code'],
    side: 'right'
  },
  {
    id: 'approve',
    title: 'Nothing runs until you approve it',
    body: 'Requests that change state or could do damage pause in the copilot. You see the exact request and why the agent wants it, then approve or deny.',
    details: ['Approval gate on every mutating action', 'The full request is shown before it is sent', 'Each decision is written to the audit log'],
    camera: [1.6, 0.9, 7.2],
    target: [3.8, -0.6, 0.2],
    focus: ['approval', 'btn-approve'],
    side: 'right'
  },
  {
    id: 'scope',
    title: 'It cannot leave the engagement',
    body: 'Network access is limited to the hosts in your scope file. The check runs inside the app, and in the containerized setup it runs again at an egress proxy.',
    details: ['Scope enforced on every request', 'Egress proxy in the container deploy', 'Self-hosted inference with vLLM'],
    camera: [-1.0, 1.6, 12.5],
    target: [3.1, -0.3, 0],
    focus: ['scope-url', 'scope-status'],
    side: 'right'
  },
  {
    id: 'run',
    title: 'Run it against your own target',
    body: 'Reconix is open source under the MIT license. Inference runs on your own vLLM server, so prompts and target data stay on your infrastructure.',
    details: [],
    camera: [8.2, 4.6, 21.5],
    target: [0.2, -0.2, 0],
    focus: [],
    side: 'left'
  }
]

export const REPO_URL = 'https://github.com/makaip/reconix'
