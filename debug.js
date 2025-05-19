const Code2Prompt = require("./index.js");

// Test with and without paths
console.log("\n=== WITH PATHS (DEFAULT) ===");
const c2p1 = new Code2Prompt({
  path: "./1/",
  diffPath: "./2/",
  diff: true,
  debugger: true,
  showPaths: true, // explicitly set to true (default)
});

console.log("\nRunning with diff mode enabled and paths shown...");
c2p1
  .generateContextPrompt()
  .then((prompt) => {
    console.log("\nGenerated diff prompt (with paths):");
    console.log(prompt);

    // Now test without paths
    console.log("\n\n=== WITHOUT PATHS ===");
    const c2p2 = new Code2Prompt({
      path: "./1/",
      diffPath: "./2/",
      diff: true,
      debugger: true,
      showPaths: false, // explicitly hide paths
    });

    console.log("\nRunning with diff mode enabled and paths hidden...");
    return c2p2.generateContextPrompt();
  })
  .then((prompt) => {
    console.log("\nGenerated diff prompt (without paths):");
    console.log(prompt);
  });
