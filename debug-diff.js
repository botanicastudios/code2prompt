const Code2Prompt = require("./index.js");
const path = require("path");
const fs = require("fs-extra");

async function main() {
  // Create test directories
  const dir1 = path.join(__dirname, "test-dir1");
  const dir2 = path.join(__dirname, "test-dir2");

  // Ensure directories exist
  await fs.ensureDir(dir1);
  await fs.ensureDir(dir2);

  // Create test files
  await fs.writeFile(
    path.join(dir1, "file1.js"),
    'console.log("Original content");'
  );
  await fs.writeFile(
    path.join(dir2, "file1.js"),
    'console.log("Modified content");'
  );

  // Initialize with debugging
  const c2p = new Code2Prompt({
    path: dir1,
    diffPath: dir2,
    diff: true,
    debugger: true,
  });

  console.log("\nTesting diff functionality...");
  const prompt = await c2p.generateContextPrompt();
  console.log("\nGenerated prompt:");
  console.log(prompt);

  // Clean up
  await fs.remove(dir1);
  await fs.remove(dir2);
}

main().catch(console.error);
