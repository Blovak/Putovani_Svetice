const fs = require('node:fs');

const FINAL_ERRORS = new Set([
  'deployment_failed',
  'deployment_content_failed',
  'deployment_cancelled',
  'deployment_lost'
]);
const POLL_INTERVAL_MS = 5000;
const TIMEOUT_MS = 25 * 60 * 1000;

const required = [
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'GITHUB_OUTPUT',
  'GITHUB_REPOSITORY',
  'GITHUB_RUN_ATTEMPT',
  'GITHUB_RUN_ID',
  'GITHUB_SHA',
  'GITHUB_TOKEN'
];

for (const name of required) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
}

const [owner, repo] = process.env.GITHUB_REPOSITORY.split('/');
const buildVersion = [
  process.env.GITHUB_SHA,
  process.env.GITHUB_RUN_ID,
  process.env.GITHUB_RUN_ATTEMPT
].join('-');
let deploymentId = '';

async function github(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Putovani-Svetice-Pages-deployer',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} ${path}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function getOidcToken() {
  const response = await fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL, {
    headers: {
      Authorization: `Bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`
    }
  });
  const data = await response.json();
  if (!response.ok || !data.value) {
    throw new Error(`Unable to obtain GitHub Actions OIDC token (${response.status}).`);
  }
  return data.value;
}

async function cancelDeployment() {
  if (!deploymentId) return;
  try {
    await github(`/repos/${owner}/${repo}/pages/deployments/${deploymentId}/cancel`, {
      method: 'POST'
    });
    console.log(`Canceled Pages deployment ${deploymentId}.`);
  } catch (error) {
    console.warn(`Unable to cancel Pages deployment ${deploymentId}: ${error.message}`);
  }
}

async function main() {
  const artifacts = await github(
    `/repos/${owner}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}/artifacts?per_page=100`
  );
  const matches = artifacts.artifacts.filter(
    artifact => artifact.name === 'github-pages' && !artifact.expired
  );
  if (matches.length !== 1) {
    throw new Error(`Expected one github-pages artifact, found ${matches.length}.`);
  }

  const deployment = await github(`/repos/${owner}/${repo}/pages/deployments`, {
    method: 'POST',
    body: JSON.stringify({
      artifact_id: matches[0].id,
      environment: 'github-pages',
      oidc_token: await getOidcToken(),
      pages_build_version: buildVersion
    })
  });
  deploymentId = String(
    deployment.id || deployment.status_url?.split('/').pop() || buildVersion
  );
  const pageUrl = deployment.page_url || `https://${owner.toLowerCase()}.github.io/${repo}/`;
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `page_url=${pageUrl}\n`);
  console.log(`Created Pages deployment ${deploymentId}.`);

  const startedAt = Date.now();
  while (Date.now() - startedAt < TIMEOUT_MS) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    const status = await github(
      `/repos/${owner}/${repo}/pages/deployments/${deploymentId}`
    );
    console.log(`Pages deployment status: ${status.status}`);
    if (status.status === 'succeed') return;
    if (FINAL_ERRORS.has(status.status)) {
      throw new Error(`Pages deployment ended with status: ${status.status}`);
    }
  }

  await cancelDeployment();
  throw new Error('Pages deployment did not finish within 25 minutes.');
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    await cancelDeployment();
    process.exit(1);
  });
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
