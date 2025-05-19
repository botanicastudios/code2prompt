const Code2Prompt = require("../index");
const path = require("path");
const fs = require("fs-extra");

async function main() {
  // Create test directories
  const originalDir = path.join(__dirname, "test-original");
  const modifiedDir = path.join(__dirname, "test-modified");

  // Create directories if they don't exist
  await fs.ensureDir(originalDir);
  await fs.ensureDir(modifiedDir);

  // Create test files in original directory
  await fs.writeFile(
    path.join(originalDir, "unchanged.js"),
    "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = add;"
  );

  await fs.writeFile(
    path.join(originalDir, "modified.js"),
    "function multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = multiply;"
  );

  await fs.writeFile(
    path.join(originalDir, "deleted.js"),
    "function subtract(a, b) {\n  return a - b;\n}\n\nmodule.exports = subtract;"
  );

  // Create test files in modified directory
  await fs.writeFile(
    path.join(modifiedDir, "unchanged.js"),
    "function add(a, b) {\n  return a + b;\n}\n\nmodule.exports = add;"
  );

  await fs.writeFile(
    path.join(modifiedDir, "modified.js"),
    "function multiply(a, b) {\n  // Added comment\n  return a * b;\n}\n\nmodule.exports = multiply;"
  );

  await fs.writeFile(
    path.join(modifiedDir, "added.js"),
    'function divide(a, b) {\n  if (b === 0) throw new Error("Division by zero");\n  return a / b;\n}\n\nmodule.exports = divide;'
  );

  // Initialize code2prompt with test directories
  const options = {
    path: modifiedDir,
    diffPath: originalDir,
    diff: true,
    extensions: ["js"],
    ignore: [],
    debugger: true,
  };

  console.log("Running diff test...");
  const code2Prompt = new Code2Prompt(options);
  const prompt = await code2Prompt.generateContextPrompt();

  console.log("\n--- Generated Prompt with Diffs ---\n");
  console.log(prompt);

  // Clean up test directories
  await fs.remove(originalDir);
  await fs.remove(modifiedDir);

  console.log("\nTest completed and directories cleaned up.");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
