const Code2Prompt = require("./index.js");
const path = require("path");
const fs = require("fs-extra");

async function main() {
  // Create test directories just like the user's scenario
  const dir1 = path.join(__dirname, "1");
  const dir2 = path.join(__dirname, "2");

  // Ensure directories exist
  await fs.ensureDir(dir1);
  await fs.ensureDir(dir2);

  // Create test files
  await fs.writeFile(path.join(dir1, "file1.js"), 'console.log("Version 1");');
  await fs.writeFile(path.join(dir2, "file1.js"), 'console.log("Version 2");');

  // Using the exact format the user mentioned
  const c2p = new Code2Prompt({
    path: "./1/",
    diffPath: "./2/",
    diff: true,
    debugger: true,
  });

  console.log("\nTesting user scenario...");
  const prompt = await c2p.generateContextPrompt();
  console.log("\nGenerated prompt:");
  console.log(prompt);

  // Clean up
  await fs.remove(dir1);
  await fs.remove(dir2);
}

main().catch(console.error);
