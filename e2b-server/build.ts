// E2B build script - builds the claude-whatsapp-server template

import { defaultBuildLogger, Template, waitForPort } from "e2b";

import {
  E2B_CPU_COUNT,
  E2B_MEMORY_MB,
  E2B_TEMPLATE_ALIAS,
  SERVER_PORT,
  WORKSPACE_DIR_NAME,
} from "./const";

// GitHub repo to clone (should contain this e2b-server code)
const GITHUB_REPO = process.env.E2B_SOURCE_REPO || "gokapso/claude-code-whatsapp";
const GITHUB_BRANCH = process.env.E2B_SOURCE_BRANCH || "master";
const GITHUB_TOKEN = process.env.E2B_GITHUB_TOKEN; // Required for private repos

// Build clone URL (with token for private repos)
// Fine-grained PATs need x-access-token format
const cloneUrl = GITHUB_TOKEN
  ? `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`
  : `https://github.com/${GITHUB_REPO}.git`;

const template = Template()
  .fromBunImage("1.3")
  .runCmd("pwd")
  .makeDir(`/home/user/${WORKSPACE_DIR_NAME}`)
  .runCmd("sudo apt install -y git curl")
  .runCmd("curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg")
  .runCmd("echo 'deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main' | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null")
  .runCmd("sudo apt update && sudo apt install -y gh")
  .skipCache()
  .gitClone(cloneUrl, "/home/user/app", {
    branch: GITHUB_BRANCH,
  })
  .setWorkdir("/home/user/app/e2b-server")
  .runCmd("ls -la")
  .runCmd("bun install")
  .setStartCmd("bun run start", waitForPort(SERVER_PORT));

async function main() {
  console.log(`Building E2B template: ${E2B_TEMPLATE_ALIAS}`);
  console.log(`Source repo: ${GITHUB_REPO} (branch: ${GITHUB_BRANCH})`);
  console.log(`CPU: ${E2B_CPU_COUNT}, Memory: ${E2B_MEMORY_MB}MB`);

  await Template.build(template, {
    alias: E2B_TEMPLATE_ALIAS,
    cpuCount: E2B_CPU_COUNT,
    memoryMB: E2B_MEMORY_MB,
    onBuildLogs: defaultBuildLogger(),
  });

  console.log(`\n✅ Template "${E2B_TEMPLATE_ALIAS}" built successfully!`);
}

main().catch(console.error);
