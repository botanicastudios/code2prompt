const Code2Prompt = require("./index.js");

// Test with and without paths
console.log("\n=== WITH PATHS (DEFAULT) ===");
const c2p1 = new Code2Prompt({
  path: "./2/",
  diffPath: "./1/",
  diff: true,
  ignore: ["AGENT.md"],
  debugger: true,
  showProjectPath: true, // explicitly set to true (default)
});

c2p1.generateContextPrompt().then((prompt) => {
  console.log("\nGenerated non-diff prompt:");
  console.log(prompt);
});
