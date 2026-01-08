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
const GITHUB_REPO = process.env.E2B_SOURCE_REPO || "kapso-ai/claude-code-whatsapp";
const GITHUB_BRANCH = process.env.E2B_SOURCE_BRANCH || "main";

const template = Template()
  .fromBunImage("1.3")
  .runCmd("pwd")
  .makeDir(`/home/user/${WORKSPACE_DIR_NAME}`)
  .runCmd("sudo apt install -y git")
  .skipCache()
  .gitClone(`https://github.com/${GITHUB_REPO}`, "/home/user/app", {
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
